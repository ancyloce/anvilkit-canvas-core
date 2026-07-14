import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createAudio,
	createCanvasIR,
	createEllipse,
	createFrame,
	createGroup,
	createImage,
	createLine,
	createPage,
	createPath,
	createPolygon,
	createRect,
	createRichText,
	createStar,
	createSvg,
	createText,
	createVideo,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import { CanvasIRSchema, CanvasNodeSchema } from "../../ir/validators.js";
import { isContainerNode } from "../../ir/walkers.js";
import {
	type CanvasExtension,
	createCanvasRuntime,
} from "../canvas-runtime.js";
import type { CanvasCommandHandler } from "../command-registry.js";
import {
	CanvasExtensionError,
	type CanvasNodeKindDefinition,
	type CanvasUnknownNode,
} from "../node-kind-registry.js";

function fixtureIR(extra?: CanvasUnknownNode): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
	});
	if (extra) {
		ir = insertNode(ir, { parentId: page.root.id, node: extra as never });
	}
	return ir;
}

/**
 * One valid node per BUILT-IN kind. Kept as a literal list (not derived from the
 * registry) on purpose: the point is to detect a kind that the registry knows
 * about but the extension-aware union does not, so deriving it from the registry
 * would defeat the test.
 */
function oneNodePerBuiltinKind(): CanvasNode[] {
	const box = { width: 10, height: 10 };
	return [
		createGroup({ id: "n-group", bounds: box }),
		createFrame({ id: "n-frame", bounds: box }),
		createRect({ id: "n-rect", bounds: box }),
		createEllipse({ id: "n-ellipse", bounds: box }),
		createPolygon({ id: "n-polygon", bounds: box }),
		createStar({ id: "n-star", bounds: box }),
		createLine({ id: "n-line", points: [0, 0, 1, 1] }),
		createPath({ id: "n-path", bounds: box, d: "M0 0 L1 1" }),
		createText({ id: "n-text", bounds: box, text: "hi" }),
		createRichText({
			id: "n-rich-text",
			bounds: box,
			width: 10,
			paragraphs: [{ spans: [{ text: "hi" }] }],
		}),
		createImage({ id: "n-image", bounds: box, assetId: "a1" }),
		createSvg({ id: "n-svg", bounds: box, assetId: "a2" }),
		{
			id: "n-ai",
			type: "ai-placeholder",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: box,
			zIndex: 0,
			jobId: "job-1",
			status: "pending",
		},
		createVideo({ id: "n-video", bounds: box, assetId: "a3" }),
		createAudio({ id: "n-audio", bounds: box, assetId: "a4" }),
	];
}

/**
 * Fake CUSTOM (non-built-in) extension kind used to exercise the extension
 * registry machinery below. Named "pinwheel", not "star" — "star" is now a
 * real built-in kind (canvas-m1-010) and registering it as an extension would
 * throw `builtin-kind-shadowed`, which is the opposite of what these tests
 * need.
 */
interface PinwheelNode extends CanvasUnknownNode {
	type: "pinwheel";
	points: number;
}

const pinwheelDef: CanvasNodeKindDefinition<PinwheelNode> = {
	kind: "pinwheel",
	schema: z.looseObject({
		id: z.string().min(1),
		name: z.string().optional(),
		transform: z.looseObject({
			x: z.number(),
			y: z.number(),
			rotation: z.number(),
			scaleX: z.number(),
			scaleY: z.number(),
		}),
		bounds: z.looseObject({ width: z.number(), height: z.number() }),
		zIndex: z.number(),
		type: z.literal("pinwheel"),
		points: z.number(),
	}) as unknown as z.ZodType<PinwheelNode>,
};

const pinwheelExt: CanvasExtension = {
	id: "pinwheel-ext",
	nodeKinds: [pinwheelDef],
};

function makePinwheel(): PinwheelNode {
	return {
		id: "s1",
		type: "pinwheel",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 20, height: 20 },
		zIndex: 0,
		points: 5,
	};
}

describe("createCanvasRuntime — default (no extensions)", () => {
	it("returns the STATIC schemas by identity (byte-identical default path)", () => {
		const rt = createCanvasRuntime();
		expect(rt.nodeSchema).toBe(CanvasNodeSchema);
		expect(rt.irSchema).toBe(CanvasIRSchema);
	});

	it("seeds the registry with all built-in kinds", () => {
		const rt = createCanvasRuntime();
		for (const k of [
			"group",
			"frame",
			"rect",
			"ellipse",
			"polygon",
			"star",
			"line",
			"path",
			"text",
			"rich-text",
			"image",
			"svg",
			"ai-placeholder",
		]) {
			expect(rt.nodeKinds.has(k)).toBe(true);
		}
		expect(rt.nodeKinds.has("pinwheel")).toBe(false);
	});

	it("parses an existing IR identically to the static schema", () => {
		const ir = fixtureIR();
		const rt = createCanvasRuntime();
		expect(rt.irSchema.parse(ir)).toEqual(CanvasIRSchema.parse(ir));
	});
});

describe("createCanvasRuntime — with a custom node kind", () => {
	it("registers the custom kind and rebuilds a fresh schema pair", () => {
		const rt = createCanvasRuntime([pinwheelExt]);
		expect(rt.nodeKinds.has("pinwheel")).toBe(true);
		expect(rt.nodeSchema).not.toBe(CanvasNodeSchema);
		expect(rt.irSchema).not.toBe(CanvasIRSchema);
	});

	it("parses a custom node where the static union rejects it", () => {
		const rt = createCanvasRuntime([pinwheelExt]);
		expect(rt.nodeSchema.parse(makePinwheel())).toMatchObject({
			type: "pinwheel",
			points: 5,
		});
		// The closed static union has no "pinwheel" member.
		expect(() => CanvasNodeSchema.parse(makePinwheel())).toThrow();
	});

	it("accepts an IR whose page contains a custom node", () => {
		const ir = fixtureIR(makePinwheel());
		const rt = createCanvasRuntime([pinwheelExt]);
		expect(() => rt.irSchema.parse(ir)).not.toThrow();
		// Same IR fails the static schema (pinwheel is unknown to the closed union).
		expect(() => CanvasIRSchema.parse(ir)).toThrow();
	});

	it("still parses built-in nodes in the extended runtime", () => {
		const rt = createCanvasRuntime([pinwheelExt]);
		expect(() => rt.irSchema.parse(fixtureIR())).not.toThrow();
	});
});

describe("createCanvasRuntime — command dispatch", () => {
	it("routes built-in commands through applyCommand (with a real inverse)", () => {
		const ir = fixtureIR();
		const rt = createCanvasRuntime();
		const { ir: next, inverse } = rt.apply(ir, {
			type: "node.move",
			nodeId: "r1",
			from: { x: 0, y: 0 },
			to: { x: 40, y: 0 },
		});
		expect(next.pages[0]?.root.children[0]?.transform.x).toBe(40);
		expect(inverse).toMatchObject({ type: "node.move", nodeId: "r1" });
	});

	/**
	 * P0-7 regression: `applyCommand`'s own "batch" case recurses through the
	 * STATIC dispatch (commands/runtime.ts), which has no knowledge of this
	 * runtime's registry. Routing `rt.apply(ir, batchCmd)` straight to
	 * `applyCommand` would silently no-op on any custom sub-command (no matching
	 * switch case, no default, `undefined` returned). `rt.apply` must recurse
	 * through ITSELF per sub-command so a custom command nested in a batch
	 * resolves exactly like a top-level one.
	 */
	it("resolves a custom command nested inside a batch (not just top-level)", () => {
		const ir = fixtureIR();
		const ext: CanvasExtension = {
			id: "tag-ext",
			commands: [
				{
					type: "custom.tag",
					apply: (cur) => ({
						ir: { ...cur, title: "tagged" },
						inverse: { type: "custom.untag" },
					}),
				},
				{
					type: "custom.untag",
					apply: (cur) => ({
						ir: { ...cur, title: "t" },
						inverse: { type: "custom.tag" },
					}),
				},
			],
		};
		const rt = createCanvasRuntime([ext]);
		const { ir: next, inverse } = rt.apply(ir, {
			type: "batch",
			commands: [
				{
					type: "node.move",
					nodeId: "r1",
					from: { x: 0, y: 0 },
					to: { x: 5, y: 0 },
				},
				{ type: "custom.tag" },
			],
		});
		expect(next.title).toBe("tagged");
		expect(next.pages[0]?.root.children[0]?.transform.x).toBe(5);
		expect(inverse).toMatchObject({ type: "batch" });
		if (inverse.type === "batch") {
			// Reversed: custom.tag's inverse first, then node.move's.
			expect(inverse.commands[0]).toMatchObject({ type: "custom.untag" });
			expect(inverse.commands[1]).toMatchObject({ type: "node.move" });
		}

		// The inverse batch round-trips through the SAME runtime-aware path.
		const undone = rt.apply(next, inverse);
		expect(undone.ir.title).toBe("t");
		expect(undone.ir.pages[0]?.root.children[0]?.transform.x).toBe(0);
	});

	it("dispatches a custom command to its registered handler", () => {
		const ir = fixtureIR();
		const ext: CanvasExtension = {
			id: "tag-ext",
			commands: [
				{
					type: "custom.tag",
					// No cast needed (P0-4): the array's contextual element type is
					// `CanvasCommandHandler<{ type: string }>`, whose default `Inverse`
					// (`{ type: string } | CanvasCommand`) already admits this shape.
					apply: (cur) => ({
						ir: { ...cur, title: "tagged" },
						inverse: { type: "custom.untag" },
					}),
				},
			],
		};
		const rt = createCanvasRuntime([ext]);
		const { ir: next } = rt.apply(ir, { type: "custom.tag" });
		expect(next.title).toBe("tagged");
	});

	/**
	 * P0-4: a `CanvasCommandHandler<C, Inverse>` whose inverse is a genuinely
	 * DIFFERENT custom command type — previously impossible to express without
	 * casting `inverse` to the built-in `CanvasCommand` union (see the `as never`
	 * this test replaced above). Registers a real tag/untag pair and round-trips
	 * through both `apply` calls with no cast anywhere in either definition.
	 */
	it("lets a custom command's handler return a distinct custom inverse type with no unsafe cast", () => {
		interface CustomTagCommand {
			type: "custom.tag";
		}
		interface CustomUntagCommand {
			type: "custom.untag";
		}
		const tagHandler: CanvasCommandHandler<
			CustomTagCommand,
			CustomUntagCommand
		> = {
			type: "custom.tag",
			apply: (cur) => ({
				ir: { ...cur, title: "tagged" },
				inverse: { type: "custom.untag" },
			}),
		};
		const untagHandler: CanvasCommandHandler<
			CustomUntagCommand,
			CustomTagCommand
		> = {
			type: "custom.untag",
			apply: (cur) => ({
				ir: { ...cur, title: "plain" },
				inverse: { type: "custom.tag" },
			}),
		};

		// The handler-level round trip is fully statically typed: `applied.inverse`
		// is exactly `CustomUntagCommand`, `undone.inverse` exactly `CustomTagCommand`.
		const ir = fixtureIR();
		const applied = tagHandler.apply(ir, { type: "custom.tag" }, {});
		expect(applied.ir.title).toBe("tagged");
		expect(applied.inverse.type).toBe("custom.untag");
		const undone = untagHandler.apply(applied.ir, applied.inverse, {});
		expect(undone.ir.title).toBe("plain");
		expect(undone.inverse.type).toBe("custom.tag");

		// The pair also works through the runtime's dynamic dispatch + registry —
		// undo/redo through `CanvasRuntime.apply` sees the same values at runtime.
		const rt = createCanvasRuntime();
		rt.commands.register(tagHandler);
		rt.commands.register(untagHandler);
		const dispatched = rt.apply(ir, { type: "custom.tag" });
		expect(dispatched.ir.title).toBe("tagged");
		expect(dispatched.inverse.type).toBe("custom.untag");
		const dispatchedBack = rt.apply(dispatched.ir, dispatched.inverse);
		expect(dispatchedBack.ir.title).toBe("plain");
	});

	it("does not let an extension shadow a built-in command type", () => {
		const ir = fixtureIR();
		const ext: CanvasExtension = {
			id: "evil-ext",
			commands: [
				{
					type: "node.move",
					apply: () => {
						throw new Error("handler should never run for a built-in type");
					},
				},
			],
		};
		const rt = createCanvasRuntime([ext]);
		expect(() =>
			rt.apply(ir, {
				type: "node.move",
				nodeId: "r1",
				from: { x: 0, y: 0 },
				to: { x: 1, y: 0 },
			}),
		).not.toThrow();
	});

	it("throws for an unknown command type with no handler", () => {
		const rt = createCanvasRuntime();
		expect(() => rt.apply(fixtureIR(), { type: "custom.unknown" })).toThrow(
			/No command handler/,
		);
	});
});

describe("createCanvasRuntime — migrate", () => {
	it("validates an already-current IR (default runtime)", () => {
		const rt = createCanvasRuntime();
		const ir = fixtureIR();
		expect(rt.migrate(ir)).toEqual(ir);
	});

	it("default runtime migrates a v1 document to v2 (built-in seed)", () => {
		const rt = createCanvasRuntime();
		const v1 = { ...fixtureIR(), version: "1", experimental: true };
		const migrated = rt.migrate(v1);
		expect(migrated.version).toBe("2");
		expect(
			(migrated as unknown as { experimental?: boolean }).experimental,
		).toBe(true);
	});

	it("default runtime rejects an unknown version (no migration path)", () => {
		const rt = createCanvasRuntime();
		expect(() => rt.migrate({ ...fixtureIR(), version: "0" })).toThrow();
	});

	it("applies a registered migration chain then validates", () => {
		const ext: CanvasExtension = {
			id: "mig-ext",
			migrations: [
				{
					from: "0",
					to: "1",
					up: (raw) => ({ ...(raw as object), version: "1" }),
				},
			],
		};
		const rt = createCanvasRuntime([ext]);
		const old = { ...fixtureIR(), version: "0" };
		// Extension step 0→1 chains into the built-in 1→2.
		const migrated = rt.migrate(old);
		expect(migrated.version).toBe("2");
	});
});

describe("container predicate ↔ kind-registry parity", () => {
	/**
	 * `isContainerNode` is a static predicate, while the registry carries the same
	 * fact as `CanvasNodeKindDefinition.isContainer`. Nothing in the type system
	 * ties them together, so a new container kind could easily be added to one and
	 * not the other — and the failure (a subtree silently not recursed into) is
	 * quiet and nasty. This test is the tie.
	 */
	it("every built-in kind flagged isContainer is exactly what isContainerNode accepts", () => {
		const builtins = createCanvasRuntime().nodeKinds.list();
		const flaggedAsContainer = builtins
			.filter((def) => def.isContainer === true)
			.map((def) => def.kind)
			.sort();
		expect(flaggedAsContainer).toEqual(["frame", "group"]);

		// isContainerNode only reads `.type`, so a bare tagged object is enough.
		for (const def of builtins) {
			const probe = { type: def.kind } as unknown as CanvasNode;
			expect(isContainerNode(probe)).toBe(def.isContainer === true);
		}
	});

	it("registers all 15 built-in kinds", () => {
		const kinds = createCanvasRuntime()
			.nodeKinds.list()
			.map((d) => d.kind)
			.sort();
		expect(kinds).toEqual([
			"ai-placeholder",
			"audio",
			"ellipse",
			"frame",
			"group",
			"image",
			"line",
			"path",
			"polygon",
			"rect",
			"rich-text",
			"star",
			"svg",
			"text",
			"video",
		]);
	});
});

describe("static schema ↔ extension-aware schema parity", () => {
	/**
	 * A new built-in kind has to be added in THREE places in this file: the
	 * validators import, `BUILTIN_KIND_DEFS`, and the separate `members` array
	 * inside `buildExtendedSchemas` (which rebuilds the union so a container's
	 * `children` can admit extension kinds). Nothing in the type system ties the
	 * third to the first two.
	 *
	 * Forget it and the failure is the nastiest kind: the DEFAULT runtime accepts
	 * the node, while any runtime with an extension kind registered silently
	 * REJECTS it — so the bug only appears for hosts that use extensions. This
	 * test is the tie: every kind the registry claims to know must parse through
	 * the extension-aware schema, not just the static one.
	 */
	it("the extension-aware union accepts every registered built-in kind", () => {
		// Registering ANY extension kind swaps the static union for the one
		// `buildExtendedSchemas` assembles — which is the union under test here.
		const rt = createCanvasRuntime([pinwheelExt]);
		expect(rt.nodeSchema).not.toBe(CanvasNodeSchema);

		for (const node of oneNodePerBuiltinKind()) {
			const result = rt.nodeSchema.safeParse(node);
			expect(
				result.success,
				`the extension-aware schema rejected built-in kind "${node.type}" — is it missing from buildExtendedSchemas' \`members\` array?`,
			).toBe(true);
		}
	});

	/**
	 * P0-3 regression: `buildExtendedSchemas` used to hand-rewrite the page shape
	 * instead of reusing `CanvasPageShape`, and dropped `variantSource`/
	 * `animation` in the rewrite. Both fields are `looseObject`-preserved either
	 * way (never stripped), but only the static schema actually VALIDATED their
	 * shape — the extension-aware runtime silently skipped that validation. This
	 * asserts both schemas reject the SAME malformed `variantSource`/`animation`.
	 */
	it("validates CanvasPage.variantSource and .animation identically on both schema paths", () => {
		const rt = createCanvasRuntime([pinwheelExt]);
		expect(rt.irSchema).not.toBe(CanvasIRSchema);

		const page = createPage({ id: "p1" });
		const validIr: CanvasIR = {
			...createCanvasIR({ id: "doc", title: "t", pages: [page] }),
			pages: [
				{
					...page,
					variantSource: {
						sourcePageId: "p0",
						presetId: "preset-1",
						presetVersion: "1",
					},
					animation: { kind: "fade", duration: 0.4 },
				},
			],
		};
		expect(CanvasIRSchema.safeParse(validIr).success).toBe(true);
		expect(rt.irSchema.safeParse(validIr).success).toBe(true);

		const invalidVariantSource: CanvasIR = {
			...validIr,
			pages: [
				{
					...validIr.pages[0],
					// Missing required `presetId`/`presetVersion` — must fail on both.
					variantSource: { sourcePageId: "p0" } as never,
				},
			],
		};
		expect(CanvasIRSchema.safeParse(invalidVariantSource).success).toBe(false);
		expect(rt.irSchema.safeParse(invalidVariantSource).success).toBe(false);

		const invalidAnimation: CanvasIR = {
			...validIr,
			pages: [
				{
					...validIr.pages[0],
					// Unknown animation `kind` — must fail on both (discriminated union).
					animation: { kind: "not-a-real-kind", duration: 1 } as never,
				},
			],
		};
		expect(CanvasIRSchema.safeParse(invalidAnimation).success).toBe(false);
		expect(rt.irSchema.safeParse(invalidAnimation).success).toBe(false);
	});
});

describe("createCanvasRuntime — built-in kind protection", () => {
	it("rejects an extension that registers a built-in node kind", () => {
		const rectShadow: CanvasExtension = {
			id: "hostile",
			nodeKinds: [
				{
					kind: "rect",
					schema: z.looseObject({
						id: z.string(),
						type: z.literal("rect"),
					}) as unknown as z.ZodType<CanvasUnknownNode>,
				},
			],
		};
		expect(() => createCanvasRuntime([rectShadow])).toThrowError(
			/built-in kinds cannot be shadowed/,
		);
	});

	it("rejects an extension that registers `frame` (now a built-in kind)", () => {
		const frameShadow: CanvasExtension = {
			id: "hostile-frame",
			nodeKinds: [
				{
					kind: "frame",
					schema: z.looseObject({
						id: z.string(),
						type: z.literal("frame"),
					}) as unknown as z.ZodType<CanvasUnknownNode>,
				},
			],
		};
		expect(() => createCanvasRuntime([frameShadow])).toThrowError(
			/built-in kinds cannot be shadowed/,
		);
		try {
			createCanvasRuntime([frameShadow]);
			expect.unreachable("registering a built-in kind must throw");
		} catch (error) {
			expect((error as CanvasExtensionError).code).toBe(
				"builtin-kind-shadowed",
			);
		}
	});

	it.each([
		"polygon",
		"star",
	] as const)("rejects an extension that registers `%s` (now a built-in kind)", (kind) => {
		const shadow: CanvasExtension = {
			id: `hostile-${kind}`,
			nodeKinds: [
				{
					kind,
					schema: z.looseObject({
						id: z.string(),
						type: z.literal(kind),
					}) as unknown as z.ZodType<CanvasUnknownNode>,
				},
			],
		};
		expect(() => createCanvasRuntime([shadow])).toThrowError(
			/built-in kinds cannot be shadowed/,
		);
		try {
			createCanvasRuntime([shadow]);
			expect.unreachable("registering a built-in kind must throw");
		} catch (error) {
			expect((error as CanvasExtensionError).code).toBe(
				"builtin-kind-shadowed",
			);
		}
	});

	it("rejects two extensions claiming the same custom kind", () => {
		const kindDef: CanvasNodeKindDefinition = {
			kind: "sticker",
			schema: z.looseObject({
				id: z.string(),
				type: z.literal("sticker"),
			}) as unknown as z.ZodType<CanvasUnknownNode>,
		};
		const a: CanvasExtension = { id: "a", nodeKinds: [kindDef] };
		const b: CanvasExtension = { id: "b", nodeKinds: [{ ...kindDef }] };
		expect(() => createCanvasRuntime([a, b])).toThrowError(
			/already registered by another extension/,
		);
	});
});
