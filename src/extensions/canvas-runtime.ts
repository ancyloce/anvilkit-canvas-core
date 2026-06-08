import { z } from "zod";
import { applyCommand } from "../commands/runtime.js";
import type {
	CanvasCommand,
	CommandApplyOptions,
	CommandApplyResult,
} from "../commands/types.js";
import {
	CANVAS_IR_VERSION,
	CanvasAiPlaceholderNodeSchema,
	CanvasAssetRefSchema,
	CanvasEllipseNodeSchema,
	CanvasGroupNodeSchema,
	CanvasImageNodeSchema,
	CanvasIRMetadataSchema,
	CanvasIRSchema,
	CanvasLineNodeSchema,
	CanvasNodeBaseShape,
	CanvasNodeSchema,
	CanvasPageBackgroundSchema,
	CanvasPageSizeSchema,
	CanvasPathNodeSchema,
	CanvasRectNodeSchema,
	CanvasTextNodeSchema,
} from "../ir-validators.js";
import type { CanvasIR, CanvasNode } from "../types.js";
import {
	type CanvasCommandHandler,
	type CanvasCommandRegistry,
	createCommandRegistry,
} from "./command-registry.js";
import {
	type CanvasMigration,
	type CanvasMigrationRegistry,
	createMigrationRegistry,
} from "./migration-registry.js";
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
	 */
	readonly apply: (
		ir: CanvasIR,
		cmd: CanvasCommand | { type: string },
		options?: CommandApplyOptions,
	) => CommandApplyResult;
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
	{ kind: "rect", schema: asKindSchema(CanvasRectNodeSchema) },
	{ kind: "ellipse", schema: asKindSchema(CanvasEllipseNodeSchema) },
	{ kind: "line", schema: asKindSchema(CanvasLineNodeSchema) },
	{ kind: "path", schema: asKindSchema(CanvasPathNodeSchema) },
	{ kind: "text", schema: asKindSchema(CanvasTextNodeSchema) },
	{ kind: "image", schema: asKindSchema(CanvasImageNodeSchema) },
	{
		kind: "ai-placeholder",
		schema: asKindSchema(CanvasAiPlaceholderNodeSchema),
	},
];

// The member-tuple type z.discriminatedUnion expects can't be expressed for a
// runtime-built list, so the assembled members are cast at the call site.
type DiscriminatedUnionMembers = Parameters<typeof z.discriminatedUnion>[1];

/**
 * Build a fresh node/IR schema pair whose discriminated union includes the
 * extension kinds. The `group` schema is rebuilt so its `z.lazy` children point
 * at THIS union, and the page/IR schemas are rebuilt so a page root's subtree
 * validates against the extended union. Mirrors the static construction in
 * `ir-validators.ts` (kept separate so the static default path is untouched).
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
	const members = [
		group,
		CanvasRectNodeSchema,
		CanvasEllipseNodeSchema,
		CanvasLineNodeSchema,
		CanvasPathNodeSchema,
		CanvasTextNodeSchema,
		CanvasImageNodeSchema,
		CanvasAiPlaceholderNodeSchema,
		...extraSchemas,
	];
	union = z.discriminatedUnion(
		"type",
		members as unknown as DiscriminatedUnionMembers,
	) as unknown as z.ZodType<CanvasNode>;

	const page = z.looseObject({
		id: z.string().min(1),
		name: z.string().optional(),
		size: CanvasPageSizeSchema,
		background: CanvasPageBackgroundSchema,
		root: group,
	});
	const irSchema = z.looseObject({
		version: z.literal("1"),
		id: z.string().min(1),
		title: z.string(),
		pages: z.array(page).min(1),
		assets: z.record(z.string(), CanvasAssetRefSchema),
		metadata: CanvasIRMetadataSchema,
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

	const apply = (
		ir: CanvasIR,
		cmd: CanvasCommand | { type: string },
		options: CommandApplyOptions = {},
	): CommandApplyResult => {
		if (BUILTIN_COMMAND_TYPES.has(cmd.type)) {
			return applyCommand(ir, cmd as CanvasCommand, options);
		}
		const handler = commands.get(cmd.type);
		if (handler) return handler.apply(ir, cmd, options);
		throw new Error(
			`No command handler registered for command type "${cmd.type}".`,
		);
	};

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
