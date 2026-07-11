import { describe, expect, it } from "vitest";
import type {
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasNode,
	CanvasPage,
	CanvasRectNode,
	CanvasTextNode,
} from "../types.js";
import {
	CANVAS_IR_VERSION,
	CanvasFrameNodeSchema,
	CanvasGroupNodeSchema,
	CanvasImageNodeSchema,
	CanvasIRSchema,
	CanvasLineNodeSchema,
	CanvasNodeSchema,
	CanvasPageSchema,
	CanvasRectNodeSchema,
	CanvasTextNodeSchema,
	CanvasTransformSchema,
	migrateCanvasIR,
} from "../validators.js";

const FIXED_TS = "2026-05-20T00:00:00.000Z";

const identityTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

const makeRect = (id: string): CanvasRectNode => ({
	id,
	type: "rect",
	transform: identityTransform,
	bounds: { width: 100, height: 50 },
	zIndex: 0,
	fill: "#ff0000",
});

const makeText = (id: string, text: string): CanvasTextNode => ({
	id,
	type: "text",
	transform: identityTransform,
	bounds: { width: 200, height: 24 },
	zIndex: 0,
	text,
	fontFamily: "Inter",
	fontSize: 16,
	fill: "#000000",
});

const makeImage = (id: string, assetId: string): CanvasImageNode => ({
	id,
	type: "image",
	transform: identityTransform,
	bounds: { width: 400, height: 300 },
	zIndex: 0,
	assetId,
});

const makeGroup = (id: string, children: CanvasNode[]): CanvasGroupNode => ({
	id,
	type: "group",
	transform: identityTransform,
	bounds: { width: 1080, height: 1080 },
	zIndex: 0,
	children,
});

const makeFrame = (id: string, children: CanvasNode[]): CanvasFrameNode => ({
	id,
	type: "frame",
	transform: identityTransform,
	bounds: { width: 400, height: 400 },
	zIndex: 0,
	children,
});

const makePage = (id: string, children: CanvasNode[]): CanvasPage => ({
	id,
	size: { width: 1080, height: 1080, unit: "px" },
	background: { kind: "solid", value: "#ffffff" },
	root: makeGroup(`${id}-root`, children),
});

const makeIR = (pages: CanvasPage[]): CanvasIR => ({
	version: "2",
	id: "ir-1",
	title: "Test IR",
	pages,
	assets: {},
	metadata: { createdAt: FIXED_TS, updatedAt: FIXED_TS },
});

describe("CanvasIRSchema", () => {
	it("accepts a valid IR with one page, one root group, and 3 leaf children", () => {
		const ir = makeIR([
			makePage("p1", [
				makeRect("r1"),
				makeText("t1", "hello"),
				makeImage("i1", "asset-1"),
			]),
		]);
		const result = CanvasIRSchema.safeParse(ir);
		expect(result.success).toBe(true);
		if (result.success) {
			// Type narrowing — should be assignable without cast.
			const back: CanvasIR = result.data;
			expect(back.pages).toHaveLength(1);
		}
	});

	it("rejects a non-current version (bare schema does not migrate)", () => {
		const ir = makeIR([makePage("p1", [])]);
		const broken = { ...ir, version: "1" as unknown as "2" };
		expect(CanvasIRSchema.safeParse(broken).success).toBe(false);
	});

	it("accepts an optional documentKind and rejects unknown kinds", () => {
		const ir = makeIR([makePage("p1", [])]);
		const withKind = { ...ir, documentKind: "template-instance" as const };
		const parsed = CanvasIRSchema.safeParse(withKind);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.documentKind).toBe("template-instance");
		}
		const badKind = { ...ir, documentKind: "banana" };
		expect(CanvasIRSchema.safeParse(badKind).success).toBe(false);
	});

	it("rejects an IR with zero pages", () => {
		const ir = makeIR([]);
		expect(CanvasIRSchema.safeParse(ir).success).toBe(false);
	});

	it("rejects an IR missing metadata", () => {
		const ir = makeIR([makePage("p1", [])]);
		const { metadata: _omitted, ...broken } = ir;
		void _omitted;
		expect(CanvasIRSchema.safeParse(broken).success).toBe(false);
	});
});

describe("CanvasNodeSchema discriminated union", () => {
	it("accepts each of the 9 node kinds", () => {
		const nodes: CanvasNode[] = [
			makeGroup("g1", []),
			makeFrame("f1", []),
			makeRect("r1"),
			{
				id: "e1",
				type: "ellipse",
				transform: identityTransform,
				bounds: { width: 50, height: 50 },
				zIndex: 0,
			},
			{
				id: "l1",
				type: "line",
				transform: identityTransform,
				bounds: { width: 100, height: 0 },
				zIndex: 0,
				points: [0, 0, 100, 0],
				stroke: "#000000",
			},
			{
				id: "p1",
				type: "path",
				transform: identityTransform,
				bounds: { width: 100, height: 100 },
				zIndex: 0,
				d: "M 0 0 L 10 10",
			},
			makeText("t1", "hi"),
			makeImage("i1", "a1"),
			{
				id: "ai1",
				type: "ai-placeholder",
				transform: identityTransform,
				bounds: { width: 200, height: 200 },
				zIndex: 0,
				jobId: "job-1",
				status: "pending",
			},
		];
		for (const n of nodes) {
			expect(CanvasNodeSchema.safeParse(n).success).toBe(true);
		}
	});

	it("rejects an unknown discriminant value", () => {
		const bogus = {
			id: "x",
			type: "frobnicate",
			transform: identityTransform,
			bounds: { width: 10, height: 10 },
			zIndex: 0,
		};
		expect(CanvasNodeSchema.safeParse(bogus).success).toBe(false);
	});

	it("validates recursive group children three levels deep", () => {
		const deepGroup = makeGroup("g1", [
			makeGroup("g2", [makeGroup("g3", [makeRect("r1")])]),
		]);
		const result = CanvasGroupNodeSchema.safeParse(deepGroup);
		expect(result.success).toBe(true);
	});

	it("validates containers nested through each other (frame > group > frame)", () => {
		const nested = makeFrame("f1", [
			makeGroup("g1", [makeFrame("f2", [makeRect("r1")])]),
		]);
		expect(CanvasFrameNodeSchema.safeParse(nested).success).toBe(true);
		// And the same tree via the union, so `z.lazy` resolves in both directions.
		expect(CanvasNodeSchema.safeParse(nested).success).toBe(true);
	});

	it("dispatches on the discriminant: a rect payload reports a rect-shaped error, not a union dump", () => {
		const badRect = {
			...makeRect("r1"),
			fontSize: -5, // not a rect field; rect requires no fontSize, so this is just ignored under loose
			bounds: { width: -1, height: 10 }, // invalid: width must be >= 0
		};
		const result = CanvasNodeSchema.safeParse(badRect);
		expect(result.success).toBe(false);
		if (!result.success) {
			// discriminatedUnion routes to the rect member only — the error path is
			// the rect's bounds.width, not a pile of "expected literal …" branches.
			expect(result.error.issues.some((i) => i.path.includes("width"))).toBe(
				true,
			);
		}
	});
});

describe("CanvasFrameNodeSchema", () => {
	it("accepts a bare frame (every frame-specific field is optional)", () => {
		expect(CanvasFrameNodeSchema.safeParse(makeFrame("f1", [])).success).toBe(
			true,
		);
	});

	it("accepts every frame-specific field, including a gradient background", () => {
		const frame = {
			...makeFrame("f1", [makeRect("r1")]),
			clip: true,
			radius: 12,
			background: {
				kind: "linear",
				stops: [
					{ offset: 0, color: "#000" },
					{ offset: 1, color: "#fff" },
				],
				from: { x: 0, y: 0 },
				to: { x: 1, y: 1 },
			},
			placeholder: { kind: "image", assetId: "a1" },
		};
		const result = CanvasFrameNodeSchema.safeParse(frame);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.placeholder).toEqual({ kind: "image", assetId: "a1" });
			expect(result.data.clip).toBe(true);
		}
	});

	it("accepts a solid-colour background (CanvasFill string form)", () => {
		const frame = { ...makeFrame("f1", []), background: "#ff0000" };
		expect(CanvasFrameNodeSchema.safeParse(frame).success).toBe(true);
	});

	it("rejects a negative radius", () => {
		const frame = { ...makeFrame("f1", []), radius: -1 };
		expect(CanvasFrameNodeSchema.safeParse(frame).success).toBe(false);
	});

	it("rejects an unknown placeholder kind", () => {
		const frame = { ...makeFrame("f1", []), placeholder: { kind: "video" } };
		expect(CanvasFrameNodeSchema.safeParse(frame).success).toBe(false);
	});

	it("rejects a frame without children (containers must carry the array)", () => {
		const { children: _children, ...noChildren } = makeFrame("f1", []);
		expect(CanvasFrameNodeSchema.safeParse(noChildren).success).toBe(false);
	});

	it("round-trips a frame document through the full IR schema unchanged", () => {
		const frame = {
			...makeFrame("f1", [makeText("t1", "hi")]),
			clip: true,
			placeholder: { kind: "logo" },
		};
		const ir = makeIR([makePage("p1", [frame])]);
		const parsed = CanvasIRSchema.parse(JSON.parse(JSON.stringify(ir)));
		expect(parsed).toEqual(ir);
	});

	it("preserves unknown keys on a frame (forward-compat with a newer peer)", () => {
		const frame = { ...makeFrame("f1", []), futureFrameField: { grid: 8 } };
		const result = CanvasNodeSchema.safeParse(frame);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(
				(result.data as unknown as { futureFrameField?: unknown })
					.futureFrameField,
			).toEqual({ grid: 8 });
		}
	});
});

describe("unknown-key handling (loose / forward-compat)", () => {
	it("preserves unknown keys on a node instead of stripping them", () => {
		const withFuture = {
			...makeRect("r1"),
			futureField: { nested: 1 },
		};
		const result = CanvasNodeSchema.safeParse(withFuture);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(
				(result.data as unknown as { futureField?: unknown }).futureField,
			).toEqual({ nested: 1 });
		}
	});

	it("preserves unknown keys across a full IR round-trip (no silent data loss)", () => {
		const ir = makeIR([makePage("p1", [makeRect("r1")])]);
		const withExtras = {
			...ir,
			experimentalFlag: true,
			pages: [
				{
					...ir.pages[0],
					root: { ...ir.pages[0]?.root, customLayoutHint: "grid" },
				},
			],
		};
		const result = CanvasIRSchema.safeParse(withExtras);
		expect(result.success).toBe(true);
		if (result.success) {
			const data = result.data as unknown as {
				experimentalFlag?: boolean;
				pages: Array<{ root: { customLayoutHint?: string } }>;
			};
			expect(data.experimentalFlag).toBe(true);
			expect(data.pages[0]?.root.customLayoutHint).toBe("grid");
		}
	});
});

describe("primitive validators", () => {
	it("CanvasTransformSchema rejects non-finite numbers", () => {
		expect(
			CanvasTransformSchema.safeParse({
				...identityTransform,
				x: Number.POSITIVE_INFINITY,
			}).success,
		).toBe(false);
		expect(
			CanvasTransformSchema.safeParse({
				...identityTransform,
				y: Number.NaN,
			}).success,
		).toBe(false);
	});

	it("CanvasLineNodeSchema requires a 4-tuple for points", () => {
		const tooShort = {
			id: "l1",
			type: "line",
			transform: identityTransform,
			bounds: { width: 10, height: 0 },
			zIndex: 0,
			points: [0, 0, 100],
			stroke: "#000000",
		};
		expect(CanvasLineNodeSchema.safeParse(tooShort).success).toBe(false);
	});

	it("CanvasPageSchema requires a group root (not a leaf)", () => {
		const bad = {
			id: "p1",
			size: { width: 100, height: 100, unit: "px" },
			background: { kind: "solid", value: "#000" },
			root: makeRect("r1"),
		};
		expect(CanvasPageSchema.safeParse(bad).success).toBe(false);
	});
});

describe("migrateCanvasIR (migration seam)", () => {
	it("validates and returns a current-version IR", () => {
		const ir = makeIR([makePage("p1", [makeRect("r1")])]);
		const out = migrateCanvasIR(ir);
		expect(out.id).toBe("ir-1");
		expect(CANVAS_IR_VERSION).toBe("2");
	});

	it("migrates a v1 document to v2", () => {
		const v1 = { ...makeIR([makePage("p1", [makeRect("r1")])]), version: "1" };
		const out = migrateCanvasIR(v1);
		expect(out.version).toBe("2");
		expect(out.pages[0]?.root.children).toHaveLength(1);
	});

	it("preserves unknown keys (loose) through migration", () => {
		const ir = { ...makeIR([makePage("p1", [])]), experimental: 1 };
		const out = migrateCanvasIR(ir) as unknown as { experimental?: number };
		expect(out.experimental).toBe(1);
	});

	it("preserves unknown keys across the v1→v2 upgrade", () => {
		const v1 = {
			...makeIR([makePage("p1", [])]),
			version: "1",
			experimental: 1,
		};
		const out = migrateCanvasIR(v1) as unknown as {
			version: string;
			experimental?: number;
		};
		expect(out.version).toBe("2");
		expect(out.experimental).toBe(1);
	});

	it("throws a clear error for an unsupported version", () => {
		const ir = { ...makeIR([makePage("p1", [])]), version: "0" };
		expect(() => migrateCanvasIR(ir)).toThrow(/Unsupported CanvasIR version/);
	});

	it("throws for non-object / version-less input", () => {
		expect(() => migrateCanvasIR(null)).toThrow(/Unsupported CanvasIR version/);
		expect(() => migrateCanvasIR(42)).toThrow(/Unsupported CanvasIR version/);
	});
});
