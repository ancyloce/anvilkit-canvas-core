import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
	CanvasExtension,
	CanvasNodeKindDefinition,
	CanvasUnknownNode,
} from "../../extensions/canvas-runtime.js";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import { MAX_FINITE_LAYOUT_MAGNITUDE } from "../../limits.js";
import type {
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasPage,
	CanvasRectNode,
} from "../types.js";
import { CANVAS_IR_VERSION, CanvasIRSchema } from "../validators.js";

/**
 * @file T-M1-04 — static vs extension-aware schema parity for the IR v3 layout
 * fields.
 *
 * `CanvasNodeBaseShape`, `CanvasFrameNodeShape` and `CanvasIRShape` are spread
 * by BOTH the static schemas in `ir/validators.ts` and by `buildExtendedSchemas`
 * in `extensions/canvas-runtime.ts`, so a field added to a shape is supposed to
 * reach both paths by construction. "By construction" is the claim this file
 * exists to keep honest: it would fail the moment someone adds a layout field to
 * one path only, or rebuilds a container schema in `buildExtendedSchemas`
 * without re-spreading the shared shape.
 *
 * Every case is asserted through BOTH schemas, comparing accept/reject AND the
 * parsed output — a path that accepts a document but silently strips
 * `autoLayout` would pass an accept-only check.
 */

const FIXED_TS = "2026-05-20T00:00:00.000Z";

const identityTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

const makeRect = (
	id: string,
	extra?: Partial<CanvasRectNode>,
): CanvasRectNode =>
	({
		id,
		type: "rect",
		transform: identityTransform,
		bounds: { width: 100, height: 50 },
		zIndex: 0,
		fill: "#ff0000",
		...extra,
	}) as CanvasRectNode;

const makeGroup = (id: string, children: CanvasNode[]): CanvasGroupNode => ({
	id,
	type: "group",
	transform: identityTransform,
	bounds: { width: 1080, height: 1080 },
	zIndex: 0,
	children,
});

const makeFrame = (
	id: string,
	children: CanvasNode[],
	extra?: Partial<CanvasFrameNode>,
): CanvasFrameNode =>
	({
		id,
		type: "frame",
		transform: identityTransform,
		bounds: { width: 400, height: 400 },
		zIndex: 0,
		children,
		...extra,
	}) as CanvasFrameNode;

const makePage = (id: string, children: CanvasNode[]): CanvasPage => ({
	id,
	size: { width: 1080, height: 1080, unit: "px" },
	background: { kind: "solid", value: "#ffffff" },
	root: makeGroup(`${id}-root`, children),
});

const makeIR = (pages: CanvasPage[], extra?: Partial<CanvasIR>): CanvasIR => ({
	version: CANVAS_IR_VERSION,
	id: "ir-1",
	title: "Parity IR",
	pages,
	assets: {},
	metadata: { createdAt: FIXED_TS, updatedAt: FIXED_TS },
	...extra,
});

const autoLayout = {
	version: 1,
	direction: "horizontal",
	padding: { top: 8, right: 8, bottom: 8, left: 8 },
	gap: 12,
	primaryAlign: "start",
	crossAlign: "center",
} as const;

/**
 * A custom node kind, so the runtime under test actually takes the
 * `buildExtendedSchemas` branch. With no extension kinds the runtime returns
 * the *identity-equal* static schemas, which would make every assertion here
 * vacuously true.
 */
interface PinwheelNode extends CanvasUnknownNode {
	type: "pinwheel";
	points: number;
}

const pinwheelDef: CanvasNodeKindDefinition<PinwheelNode> = {
	kind: "pinwheel",
	schema: z.looseObject({
		id: z.string().min(1),
		type: z.literal("pinwheel"),
		transform: z.looseObject({
			x: z.number(),
			y: z.number(),
			rotation: z.number(),
			scaleX: z.number(),
			scaleY: z.number(),
		}),
		bounds: z.looseObject({ width: z.number(), height: z.number() }),
		zIndex: z.number(),
		points: z.number(),
	}) as unknown as z.ZodType<PinwheelNode>,
};

const pinwheelExt: CanvasExtension = {
	id: "pinwheel-ext",
	nodeKinds: [pinwheelDef],
};

const extendedIRSchema = createCanvasRuntime([pinwheelExt]).irSchema;

it("the runtime under test really is the extension-aware path", () => {
	// Guards the whole file: if this ever becomes identity-equal to the static
	// schema, every parity assertion below stops proving anything.
	expect(extendedIRSchema).not.toBe(CanvasIRSchema);
});

/**
 * Assert both schemas agree on a candidate document — same verdict, and (when
 * accepted) byte-identical parsed output.
 */
function expectParity(candidate: unknown, shouldAccept: boolean): void {
	const staticResult = CanvasIRSchema.safeParse(candidate);
	const extendedResult = extendedIRSchema.safeParse(candidate);

	expect(staticResult.success).toBe(shouldAccept);
	expect(extendedResult.success).toBe(shouldAccept);

	if (staticResult.success && extendedResult.success) {
		expect(extendedResult.data).toEqual(staticResult.data);
	}
}

describe("layout field parity — static vs extension-aware IR schema", () => {
	it("accepts autoLayout on a frame identically on both paths", () => {
		const ir = makeIR([
			makePage("p1", [makeFrame("f1", [makeRect("r1")], { autoLayout })]),
		]);
		expectParity(ir, true);

		// The field must SURVIVE the parse, not merely be tolerated by it.
		const parsed = extendedIRSchema.parse(ir);
		const frame = parsed.pages[0]?.root.children[0] as CanvasFrameNode;
		expect(frame.autoLayout).toEqual(autoLayout);
	});

	it("accepts layoutItem on any node identically on both paths", () => {
		const ir = makeIR([
			makePage("p1", [
				makeFrame(
					"f1",
					[
						makeRect("r1", {
							layoutItem: { positioning: "flow", widthSizing: "fill" },
						}),
						makeRect("r2", {
							layoutItem: { positioning: "absolute" },
						}),
					],
					{ autoLayout },
				),
			]),
		]);
		expectParity(ir, true);

		const parsed = extendedIRSchema.parse(ir);
		const frame = parsed.pages[0]?.root.children[0] as CanvasFrameNode;
		expect(frame.children[0]?.layoutItem).toEqual({
			positioning: "flow",
			widthSizing: "fill",
		});
	});

	it("accepts layoutItem on a node nested under a CUSTOM extension kind's sibling", () => {
		// The extension union rebuilds every container schema; this pins that the
		// rebuilt frame still carries the layout fields.
		const ir = makeIR([
			makePage("p1", [
				makeFrame(
					"f1",
					[
						{
							id: "pw1",
							type: "pinwheel",
							transform: identityTransform,
							bounds: { width: 20, height: 20 },
							zIndex: 0,
							points: 5,
						} as unknown as CanvasNode,
						makeRect("r1", { layoutItem: { heightSizing: "hug" } }),
					],
					{ autoLayout },
				),
			]),
		]);

		// The static schema rejects the custom kind; the extended one accepts it.
		// That divergence is expected and is exactly why parity is asserted on
		// layout fields rather than on this document.
		expect(CanvasIRSchema.safeParse(ir).success).toBe(false);
		const parsed = extendedIRSchema.parse(ir);
		const frame = parsed.pages[0]?.root.children[0] as CanvasFrameNode;
		expect(frame.autoLayout).toEqual(autoLayout);
		expect(frame.children[1]?.layoutItem).toEqual({ heightSizing: "hug" });
	});

	it("accepts a compatibility record identically on both paths", () => {
		const ir = makeIR([makePage("p1", [makeFrame("f1", [], { autoLayout })])], {
			compatibility: {
				schemaVersion: CANVAS_IR_VERSION,
				minReaderSchemaVersion: "3",
				requiredCapabilities: ["layout.auto.v1"],
			},
		});
		expectParity(ir, true);
	});

	it("accepts a materialization stamp identically on both paths", () => {
		const ir = makeIR([makePage("p1", [])], {
			layoutMaterialization: {
				engineVersion: 1,
				inputHash: "abc123",
				resolvedAtRevision: 7,
			},
		});
		expectParity(ir, true);
	});

	it("preserves unknown keys inside autoLayout on both paths", () => {
		const ir = makeIR([
			makePage("p1", [
				makeFrame("f1", [], {
					autoLayout: {
						...autoLayout,
						futureField: "keep me",
					} as unknown as CanvasFrameNode["autoLayout"],
				}),
			]),
		]);
		expectParity(ir, true);

		const parsed = extendedIRSchema.parse(ir);
		const frame = parsed.pages[0]?.root.children[0] as CanvasFrameNode;
		expect(
			(frame.autoLayout as unknown as { futureField?: string }).futureField,
		).toBe("keep me");
	});
});

describe("capability openness (AC-010) — parity on both paths", () => {
	it("accepts a capability string this build does not know", () => {
		// The whole point of the open `z.array(z.string())`: a document naming a
		// FUTURE capability must reach the compatibility check, not die at parse.
		const ir = makeIR([makePage("p1", [])], {
			compatibility: {
				schemaVersion: CANVAS_IR_VERSION,
				minReaderSchemaVersion: "3",
				requiredCapabilities: ["test.future.v9"],
			},
		});
		expectParity(ir, true);

		const parsed = CanvasIRSchema.parse(ir);
		expect(parsed.compatibility?.requiredCapabilities).toEqual([
			"test.future.v9",
		]);
	});

	it("accepts an empty capability list", () => {
		expectParity(
			makeIR([makePage("p1", [])], {
				compatibility: {
					schemaVersion: CANVAS_IR_VERSION,
					minReaderSchemaVersion: "3",
					requiredCapabilities: [],
				},
			}),
			true,
		);
	});

	it("rejects a non-string capability entry on both paths", () => {
		expectParity(
			makeIR([makePage("p1", [])], {
				compatibility: {
					schemaVersion: CANVAS_IR_VERSION,
					minReaderSchemaVersion: "3",
					requiredCapabilities: [42],
				} as unknown as CanvasIR["compatibility"],
			}),
			false,
		);
	});

	it("rejects a compatibility record whose schemaVersion is not the document's", () => {
		expectParity(
			makeIR([makePage("p1", [])], {
				compatibility: {
					schemaVersion: "2",
					minReaderSchemaVersion: "2",
					requiredCapabilities: [],
				} as unknown as CanvasIR["compatibility"],
			}),
			false,
		);
	});
});

describe("numeric rules (TS-06) — parity on both paths", () => {
	const withLayout = (layout: Record<string, unknown>): unknown =>
		makeIR([
			makePage("p1", [
				makeFrame("f1", [], {
					autoLayout: layout as unknown as CanvasFrameNode["autoLayout"],
				}),
			]),
		]);

	it("rejects a negative gap", () => {
		expectParity(withLayout({ ...autoLayout, gap: -1 }), false);
	});

	it("rejects a non-finite gap", () => {
		expectParity(
			withLayout({ ...autoLayout, gap: Number.POSITIVE_INFINITY }),
			false,
		);
		expectParity(withLayout({ ...autoLayout, gap: Number.NaN }), false);
	});

	it("rejects a gap beyond MAX_FINITE_LAYOUT_MAGNITUDE", () => {
		expectParity(
			withLayout({ ...autoLayout, gap: MAX_FINITE_LAYOUT_MAGNITUDE + 1e3 }),
			false,
		);
		// ...and accepts one exactly at the ceiling.
		expectParity(
			withLayout({ ...autoLayout, gap: MAX_FINITE_LAYOUT_MAGNITUDE }),
			true,
		);
	});

	it("rejects a negative value on EVERY padding edge", () => {
		for (const edge of ["top", "right", "bottom", "left"] as const) {
			expectParity(
				withLayout({
					...autoLayout,
					padding: { ...autoLayout.padding, [edge]: -1 },
				}),
				false,
			);
		}
	});

	it("rejects an unknown enum value rather than tolerating it", () => {
		// Unknown KEYS survive (looseObject) but unknown ENUM VALUES do not —
		// the asymmetry that forces capability gating to be the forward-compat
		// mechanism (TD §6.1).
		expectParity(withLayout({ ...autoLayout, direction: "diagonal" }), false);
		expectParity(
			withLayout({ ...autoLayout, primaryAlign: "space-between" }),
			false,
		);
	});

	it("rejects an unknown layoutItem sizing value", () => {
		expectParity(
			makeIR([
				makePage("p1", [
					makeRect("r1", {
						layoutItem: { widthSizing: "wrap" },
					} as unknown as Partial<CanvasRectNode>),
				]),
			]),
			false,
		);
	});

	it("rejects an autoLayout missing a required field", () => {
		const { gap: _gap, ...noGap } = autoLayout;
		expectParity(withLayout(noGap), false);
	});
});
