import { z } from "zod";
import { applyCommand } from "../commands/runtime.js";
import type {
	CanvasCommand,
	CommandApplyOptions,
	CommandApplyResult,
} from "../commands/types.js";
import {
	type CanvasMigration,
	type CanvasMigrationRegistry,
	createMigrationRegistry,
} from "../ir/migrations.js";
import type { CanvasIR, CanvasNode } from "../ir/types.js";
import {
	CANVAS_IR_VERSION,
	CanvasAiPlaceholderNodeSchema,
	CanvasAudioNodeSchema,
	CanvasEllipseNodeSchema,
	CanvasFrameNodeSchema,
	CanvasFrameNodeShape,
	CanvasGroupNodeSchema,
	CanvasImageNodeSchema,
	CanvasIRSchema,
	CanvasIRShape,
	CanvasLineNodeSchema,
	CanvasNodeBaseShape,
	CanvasNodeSchema,
	CanvasPageShape,
	CanvasPathNodeSchema,
	CanvasPolygonNodeSchema,
	CanvasRectNodeSchema,
	CanvasRichTextNodeSchema,
	CanvasStarNodeSchema,
	CanvasSvgNodeSchema,
	CanvasTextNodeSchema,
	CanvasVideoNodeSchema,
} from "../ir/validators.js";
import {
	type CanvasCommandHandler,
	type CanvasCommandRegistry,
	createCommandRegistry,
} from "./command-registry.js";
import {
	type CanvasNodeKindDefinition,
	type CanvasNodeKindRegistry,
	type CanvasUnknownNode,
	createNodeKindRegistry,
} from "./node-kind-registry.js";

/**
 * A bundle of domain extensions registered against a {@link CanvasRuntime}.
 */
export interface CanvasExtension {
	readonly id: string;
	readonly nodeKinds?: readonly CanvasNodeKindDefinition[];
	readonly commands?: readonly CanvasCommandHandler[];
	readonly migrations?: readonly CanvasMigration[];
}

/**
 * The resolved runtime = built-ins + extensions. With NO extension node kinds,
 * `nodeSchema`/`irSchema` are the exact static module schemas (identity-equal),
 * so the zero-extension runtime is behaviourally identical to today.
 */
export interface CanvasRuntime {
	readonly nodeKinds: CanvasNodeKindRegistry;
	readonly commands: CanvasCommandRegistry;
	readonly migrations: CanvasMigrationRegistry;
	readonly nodeSchema: z.ZodType<CanvasNode>;
	readonly irSchema: z.ZodType<CanvasIR>;
	/**
	 * Apply a command: built-in types go to the core `applyCommand` (and cannot be
	 * shadowed by an extension); custom types dispatch to their registered handler.
	 * Throws for an unknown type with no handler.
	 *
	 * Generic over the command type `C` (P0-4), defaulted to the built-in
	 * `CanvasCommand` union so a built-in-only caller needs no type argument —
	 * `runtime.apply(ir, cmd)` behaves exactly as `applyCommand(ir, cmd)` would.
	 * A caller dispatching a custom command supplies `C` (or lets it infer from
	 * a typed `cmd` value) to get back `inverse: C | CanvasCommand` instead of
	 * only the built-in union, with no cast required at the call site.
	 */
	readonly apply: <C extends { type: string } = CanvasCommand>(
		ir: CanvasIR,
		cmd: C,
		options?: CommandApplyOptions,
	) => CommandApplyResult<C | CanvasCommand>;
	/**
	 * Forward-migrate a persisted/peer IR to the current version via the migration
	 * registry, then validate with this runtime's `irSchema`. The default runtime
	 * (no migrations) accepts already-current documents and rejects others.
	 */
	readonly migrate: (raw: unknown) => CanvasIR;
}

/**
 * Built-in command types — routed to the core `applyCommand` and never
 * overridable by a registered handler. Mirrors the `applyCommand` switch.
 */
const BUILTIN_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"node.create",
	"node.delete",
	"node.reorder",
	"node.reparent",
	"node.move",
	"node.resize",
	"node.rotate",
	"node.update",
	"image.replace",
	"node.group",
	"node.ungroup",
	"page.create",
	"page.delete",
	"page.reorder",
	"page.rename",
	"page.resize",
	"page.set-background",
	"asset.put",
	"asset.remove",
	"batch",
]);

function asKindSchema(s: z.ZodType<unknown>): z.ZodType<CanvasUnknownNode> {
	return s as unknown as z.ZodType<CanvasUnknownNode>;
}

/**
 * Built-in node kinds, seeded into every runtime's registry. Built-ins are
 * created via the typed `ir-builders` factories (not the registry), so `create`
 * is omitted; their schemas back the registry lookups used by serialize/render.
 */
const BUILTIN_KIND_DEFS: CanvasNodeKindDefinition[] = [
	{
		kind: "group",
		schema: asKindSchema(CanvasGroupNodeSchema),
		isContainer: true,
	},
	{
		kind: "frame",
		schema: asKindSchema(CanvasFrameNodeSchema),
		isContainer: true,
	},
	{ kind: "rect", schema: asKindSchema(CanvasRectNodeSchema) },
	{ kind: "ellipse", schema: asKindSchema(CanvasEllipseNodeSchema) },
	{ kind: "polygon", schema: asKindSchema(CanvasPolygonNodeSchema) },
	{ kind: "star", schema: asKindSchema(CanvasStarNodeSchema) },
	{ kind: "line", schema: asKindSchema(CanvasLineNodeSchema) },
	{ kind: "path", schema: asKindSchema(CanvasPathNodeSchema) },
	{ kind: "text", schema: asKindSchema(CanvasTextNodeSchema) },
	// A leaf, so `isContainer` stays omitted (it defaults to false). Setting it
	// would silently make walkers recurse into a node with no `children` — the
	// container↔registry parity test exists to catch exactly that.
	{ kind: "rich-text", schema: asKindSchema(CanvasRichTextNodeSchema) },
	{ kind: "image", schema: asKindSchema(CanvasImageNodeSchema) },
	{ kind: "svg", schema: asKindSchema(CanvasSvgNodeSchema) },
	{
		kind: "ai-placeholder",
		schema: asKindSchema(CanvasAiPlaceholderNodeSchema),
	},
	{ kind: "video", schema: asKindSchema(CanvasVideoNodeSchema) },
	{ kind: "audio", schema: asKindSchema(CanvasAudioNodeSchema) },
];

// The member-tuple type z.discriminatedUnion expects can't be expressed for a
// runtime-built list, so the assembled members are cast at the call site.
type DiscriminatedUnionMembers = Parameters<typeof z.discriminatedUnion>[1];

/**
 * Build a fresh node/IR schema pair whose discriminated union includes the
 * extension kinds. EVERY container schema (`group`, `frame`) is rebuilt so its
 * `z.lazy` children point at THIS union — a container still bound to the static
 * union would reject a custom kind nested inside it — and the page/IR schemas are
 * rebuilt so a page root's subtree validates against the extended union. Mirrors
 * the static construction in `ir-validators.ts` (kept separate so the static
 * default path is untouched).
 */
function buildExtendedSchemas(
	extraSchemas: readonly z.ZodType<CanvasUnknownNode>[],
): { nodeSchema: z.ZodType<CanvasNode>; irSchema: z.ZodType<CanvasIR> } {
	let union: z.ZodType<CanvasNode>;
	const group = z.looseObject({
		...CanvasNodeBaseShape,
		type: z.literal("group"),
		children: z.array(z.lazy(() => union)),
	});
	const frame = z.looseObject({
		...CanvasFrameNodeShape,
		children: z.array(z.lazy(() => union)),
	});
	const members = [
		group,
		frame,
		CanvasRectNodeSchema,
		CanvasEllipseNodeSchema,
		CanvasPolygonNodeSchema,
		CanvasStarNodeSchema,
		CanvasLineNodeSchema,
		CanvasPathNodeSchema,
		CanvasTextNodeSchema,
		CanvasRichTextNodeSchema,
		CanvasImageNodeSchema,
		CanvasSvgNodeSchema,
		CanvasAiPlaceholderNodeSchema,
		CanvasVideoNodeSchema,
		CanvasAudioNodeSchema,
		...extraSchemas,
	];
	union = z.discriminatedUnion(
		"type",
		members as unknown as DiscriminatedUnionMembers,
	) as unknown as z.ZodType<CanvasNode>;

	// Spreads the SAME shape objects the static `CanvasPageSchema`/`CanvasIRSchema`
	// spread (`ir/validators.ts`) — only `root`/`pages` are rebound to the
	// extended union, so every other field (incl. `variantSource`/`animation`)
	// validates identically on both paths by construction (P0-3).
	const page = z.looseObject({
		...CanvasPageShape,
		root: group,
	});
	const irSchema = z.looseObject({
		...CanvasIRShape,
		pages: z.array(page).min(1),
	}) as unknown as z.ZodType<CanvasIR>;

	return { nodeSchema: union, irSchema };
}

/**
 * Resolve a runtime from zero or more extensions. The zero-extension result is
 * identical to the static exports; registering custom node kinds rebuilds the
 * schema pair to include them.
 */
export function createCanvasRuntime(
	extensions: readonly CanvasExtension[] = [],
): CanvasRuntime {
	const nodeKinds = createNodeKindRegistry(BUILTIN_KIND_DEFS);
	const commands = createCommandRegistry();
	const migrations = createMigrationRegistry();
	const extraSchemas: z.ZodType<CanvasUnknownNode>[] = [];

	for (const ext of extensions) {
		for (const def of ext.nodeKinds ?? []) {
			nodeKinds.register(def);
			extraSchemas.push(def.schema);
		}
		for (const handler of ext.commands ?? []) commands.register(handler);
		for (const migration of ext.migrations ?? [])
			migrations.register(migration);
	}

	// One internal cast per branch, at the dynamic-dispatch boundary: `commands`
	// stores handlers behind a type-erased `Map` (necessarily — it holds
	// arbitrarily many distinct C/Inverse pairs), so re-attaching the caller's
	// static `C` to the runtime lookup's result is unavoidable here. This is the
	// ONLY place the cast happens; nothing an extension author writes (defining
	// or registering a handler, or calling `runtime.apply<C>(...)`) needs one.
	function apply<C extends { type: string } = CanvasCommand>(
		ir: CanvasIR,
		cmd: C,
		options: CommandApplyOptions = {},
	): CommandApplyResult<C | CanvasCommand> {
		if (cmd.type === "batch") {
			// `applyCommand`'s OWN "batch" case recurses through the STATIC
			// dispatch (commands/runtime.ts's `applyBatch` calls `applyCommand`,
			// not this runtime) — so routing straight to it would silently no-op
			// on any custom sub-command nested in the batch (the static switch has
			// no matching case, no default, and returns `undefined`). Recurse
			// through THIS runtime's `apply` for each sub-command instead, so a
			// custom command inside a batch resolves via the registry exactly like
			// a top-level one does. An all-built-in batch still ends up dispatching
			// every sub-command to `applyCommand`, one at a time — identical result.
			const batch = cmd as unknown as { label?: string; commands: unknown[] };
			let working = ir;
			const inverses: (CanvasCommand | { type: string })[] = [];
			for (const sub of batch.commands as Array<{ type: string }>) {
				const result = apply(working, sub, options);
				working = result.ir;
				inverses.push(result.inverse);
			}
			inverses.reverse();
			return {
				ir: working,
				inverse: {
					type: "batch",
					...(batch.label !== undefined ? { label: batch.label } : {}),
					commands: inverses,
				},
			} as CommandApplyResult<C | CanvasCommand>;
		}
		if (BUILTIN_COMMAND_TYPES.has(cmd.type)) {
			return applyCommand(
				ir,
				cmd as unknown as CanvasCommand,
				options,
			) as CommandApplyResult<C | CanvasCommand>;
		}
		const handler = commands.get(cmd.type);
		if (handler) {
			return handler.apply(ir, cmd, options) as CommandApplyResult<
				C | CanvasCommand
			>;
		}
		throw new Error(
			`No command handler registered for command type "${cmd.type}".`,
		);
	}

	let nodeSchema: z.ZodType<CanvasNode>;
	let irSchema: z.ZodType<CanvasIR>;
	if (extraSchemas.length === 0) {
		nodeSchema = CanvasNodeSchema;
		irSchema = CanvasIRSchema;
	} else {
		({ nodeSchema, irSchema } = buildExtendedSchemas(extraSchemas));
	}

	const migrate = (raw: unknown): CanvasIR =>
		irSchema.parse(migrations.migrate(raw, CANVAS_IR_VERSION));

	return {
		nodeKinds,
		commands,
		migrations,
		apply,
		migrate,
		nodeSchema,
		irSchema,
	};
}
