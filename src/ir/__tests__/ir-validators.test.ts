import { describe, expect, it } from "vitest";
import type {
	BrandTokenRef,
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasNode,
	CanvasPage,
	CanvasPolygonNode,
	CanvasRectNode,
	CanvasRichTextNode,
	CanvasStarNode,
	CanvasTextNode,
} from "../types.js";
import {
	BrandTokenRefSchema,
	CANVAS_IR_VERSION,
	CanvasFillSchema,
	CanvasFrameNodeSchema,
	CanvasGroupNodeSchema,
	CanvasImageNodeSchema,
	CanvasIRSchema,
	CanvasLineNodeSchema,
	CanvasNodeSchema,
	CanvasPageLayoutAidsSchema,
	CanvasPageSchema,
	CanvasPolygonNodeSchema,
	CanvasRectNodeSchema,
	CanvasRichTextNodeSchema,
	CanvasStarNodeSchema,
	CanvasTextNodeSchema,
	CanvasTransformSchema,
	FramePlaceholderSchema,
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

const makePolygon = (id: string): CanvasPolygonNode => ({
	id,
	type: "polygon",
	transform: identityTransform,
	bounds: { width: 60, height: 60 },
	zIndex: 0,
	sides: 5,
});

const makeStar = (id: string): CanvasStarNode => ({
	id,
	type: "star",
	transform: identityTransform,
	bounds: { width: 60, height: 60 },
	zIndex: 0,
	points: 5,
	innerRadiusRatio: 0.5,
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

const makeRichText = (id: string): CanvasRichTextNode => ({
	id,
	type: "rich-text",
	transform: identityTransform,
	bounds: { width: 200, height: 60 },
	zIndex: 0,
	width: 200,
	paragraphs: [{ spans: [{ text: "hi" }] }],
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
	it("accepts each of the 12 node kinds", () => {
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
			makePolygon("poly1"),
			makeStar("star1"),
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
			makeRichText("rt1"),
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

	it("accepts a node omitting zIndex — reserved/unused, not required (C-9)", () => {
		const rectWithoutZIndex = {
			id: "r1",
			type: "rect",
			transform: identityTransform,
			bounds: { width: 10, height: 10 },
		};
		expect(CanvasNodeSchema.safeParse(rectWithoutZIndex).success).toBe(true);
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

	it("CanvasPageSchema accepts a page with no variantSource (the common case)", () => {
		const page = {
			id: "p1",
			size: { width: 100, height: 100, unit: "px" },
			background: { kind: "solid", value: "#000" },
			root: makeGroup("g1", []),
		};
		expect(CanvasPageSchema.safeParse(page).success).toBe(true);
	});

	it("CanvasPageSchema accepts a variant page's variantSource (canvas-m3-007)", () => {
		const page = {
			id: "p1",
			size: { width: 1080, height: 1080, unit: "px" },
			background: { kind: "solid", value: "#000" },
			root: makeGroup("g1", []),
			variantSource: {
				sourcePageId: "source-page",
				presetId: "instagram-post",
				presetVersion: "1",
			},
		};
		expect(CanvasPageSchema.safeParse(page).success).toBe(true);
	});

	it("CanvasPageSchema rejects a variantSource missing a required field", () => {
		const page = {
			id: "p1",
			size: { width: 100, height: 100, unit: "px" },
			background: { kind: "solid", value: "#000" },
			root: makeGroup("g1", []),
			variantSource: {
				sourcePageId: "source-page",
				presetId: "instagram-post",
			},
		};
		expect(CanvasPageSchema.safeParse(page).success).toBe(false);
	});

	it("CanvasPageSchema accepts full layoutAids and round-trips them (C-01, §9.3)", () => {
		const page = {
			id: "p1",
			size: { width: 100, height: 100, unit: "px" },
			background: { kind: "solid", value: "#000" },
			root: makeGroup("g1", []),
			layoutAids: {
				guides: { horizontal: [10, 50.5], vertical: [-4, 90] },
				margin: { top: 8, right: 8, bottom: 8, left: 8 },
				bleed: { top: 3, right: 3, bottom: 3, left: 3 },
				safeArea: { top: 250, right: 0, bottom: 250, left: 0 },
			},
		};
		const parsed = CanvasPageSchema.safeParse(page);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.layoutAids).toEqual(page.layoutAids);
		}
	});

	it("CanvasPageLayoutAidsSchema accepts partial aids and rejects non-finite guide positions", () => {
		expect(
			CanvasPageLayoutAidsSchema.safeParse({
				guides: { horizontal: [], vertical: [12] },
			}).success,
		).toBe(true);
		expect(
			CanvasPageLayoutAidsSchema.safeParse({
				margin: { top: 1, right: 2, bottom: 3, left: 4 },
			}).success,
		).toBe(true);
		expect(
			CanvasPageLayoutAidsSchema.safeParse({
				guides: { horizontal: [Number.NaN], vertical: [] },
			}).success,
		).toBe(false);
		expect(
			CanvasPageLayoutAidsSchema.safeParse({
				bleed: { top: Number.POSITIVE_INFINITY, right: 0, bottom: 0, left: 0 },
			}).success,
		).toBe(false);
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

describe("CanvasRichTextNodeSchema", () => {
	const base = makeRichText("rt1");

	it("accepts a minimal rich-text node", () => {
		expect(CanvasRichTextNodeSchema.safeParse(base).success).toBe(true);
	});

	it("accepts every field populated", () => {
		const full: CanvasRichTextNode = {
			...base,
			name: "Heading",
			height: 80,
			overflow: "ellipsis",
			wrap: "word",
			paragraphs: [
				{
					align: "center",
					lineHeight: 1.4,
					spans: [
						{
							text: "Hello",
							fontFamily: "Inter",
							fontSize: 24,
							fontWeight: "700",
							italic: true,
							underline: true,
							letterSpacing: -0.5,
							textTransform: "uppercase",
							fill: "#ff0000",
						},
						{
							text: " world",
							fill: {
								kind: "linear",
								from: { x: 0, y: 0 },
								to: { x: 1, y: 0 },
								stops: [
									{ offset: 0, color: "#000" },
									{ offset: 1, color: "#fff" },
								],
							},
						},
					],
				},
				{ spans: [] },
			],
		};
		expect(CanvasRichTextNodeSchema.safeParse(full).success).toBe(true);
	});

	// An empty span is how an editor represents a caret in a freshly-split
	// paragraph, and an empty paragraph list must not be a parse error either.
	it("accepts empty spans and empty paragraph lists", () => {
		expect(
			CanvasRichTextNodeSchema.safeParse({
				...base,
				paragraphs: [{ spans: [{ text: "" }] }],
			}).success,
		).toBe(true);
		expect(
			CanvasRichTextNodeSchema.safeParse({ ...base, paragraphs: [] }).success,
		).toBe(true);
	});

	// letterSpacing tightens as well as loosens, so it must admit negatives —
	// unlike fontSize/width/height, which are non-negative.
	it("allows negative letterSpacing but rejects a negative fontSize", () => {
		const neg = (span: Record<string, unknown>) =>
			CanvasRichTextNodeSchema.safeParse({
				...base,
				paragraphs: [{ spans: [{ text: "x", ...span }] }],
			}).success;
		expect(neg({ letterSpacing: -2 })).toBe(true);
		expect(neg({ fontSize: -2 })).toBe(false);
	});

	it("rejects each invalid field", () => {
		const bad: Array<Record<string, unknown>> = [
			{ width: -1 },
			{ width: Number.POSITIVE_INFINITY },
			{ height: -1 },
			{ paragraphs: "nope" },
			{ paragraphs: [{ spans: [{ text: 42 }] }] },
			{ paragraphs: [{ spans: [{ text: "x" }], lineHeight: -1 }] },
			{ paragraphs: [{ spans: [{ text: "x" }], align: "justify" }] },
			{ paragraphs: [{ spans: [{ text: "x", textTransform: "smallcaps" }] }] },
			{ overflow: "scroll" },
			{ wrap: "anywhere" },
		];
		for (const patch of bad) {
			expect(
				CanvasRichTextNodeSchema.safeParse({ ...base, ...patch }).success,
				`expected ${JSON.stringify(patch)} to be rejected`,
			).toBe(false);
		}
	});

	// The looseObject posture is the CRDT/forward-compat contract: a newer peer's
	// extra fields must survive an older build's round-trip, not be stripped.
	it("preserves unknown fields through a round-trip", () => {
		const withExtra = {
			...base,
			futureField: "keep me",
			paragraphs: [
				{ spans: [{ text: "hi", futureSpanField: 7 }], futureParaField: true },
			],
		};
		const parsed = CanvasRichTextNodeSchema.parse(withExtra);
		expect(parsed).toEqual(withExtra);
	});

	it("round-trips through JSON unchanged", () => {
		const parsed = CanvasRichTextNodeSchema.parse(
			JSON.parse(JSON.stringify(base)),
		);
		expect(parsed).toEqual(base);
	});
});

describe("CanvasPolygonNodeSchema", () => {
	const base = makePolygon("poly1");

	it("accepts a minimal polygon (fill/stroke/shadow all optional)", () => {
		expect(CanvasPolygonNodeSchema.safeParse(base).success).toBe(true);
	});

	it("accepts every field populated, including a gradient fill and shadow", () => {
		const full: CanvasPolygonNode = {
			...base,
			sides: 8,
			fill: {
				kind: "radial",
				stops: [
					{ offset: 0, color: "#fff" },
					{ offset: 1, color: "#000" },
				],
				from: { x: 0.5, y: 0.5 },
				to: { x: 1, y: 1 },
			},
			stroke: "#333333",
			strokeWidth: 2,
			shadow: { color: "#000000", blur: 4, offsetX: 2, offsetY: 2 },
		};
		expect(CanvasPolygonNodeSchema.safeParse(full).success).toBe(true);
	});

	it("rejects sides below the floor of 3", () => {
		expect(
			CanvasPolygonNodeSchema.safeParse({ ...base, sides: 2 }).success,
		).toBe(false);
	});

	it("rejects a non-integer sides count", () => {
		expect(
			CanvasPolygonNodeSchema.safeParse({ ...base, sides: 4.5 }).success,
		).toBe(false);
	});

	it("round-trips through JSON unchanged", () => {
		const parsed = CanvasPolygonNodeSchema.parse(
			JSON.parse(JSON.stringify(base)),
		);
		expect(parsed).toEqual(base);
	});

	it("preserves unknown fields (forward-compat)", () => {
		const withExtra = { ...base, futureField: "keep me" };
		expect(CanvasPolygonNodeSchema.parse(withExtra)).toEqual(withExtra);
	});
});

describe("CanvasStarNodeSchema", () => {
	const base = makeStar("star1");

	it("accepts a minimal star (fill/stroke/shadow all optional)", () => {
		expect(CanvasStarNodeSchema.safeParse(base).success).toBe(true);
	});

	it("accepts every field populated, including a gradient fill and shadow", () => {
		const full: CanvasStarNode = {
			...base,
			points: 6,
			innerRadiusRatio: 0.4,
			fill: {
				kind: "linear",
				stops: [
					{ offset: 0, color: "#fff" },
					{ offset: 1, color: "#000" },
				],
				from: { x: 0, y: 0 },
				to: { x: 1, y: 1 },
			},
			stroke: "#333333",
			strokeWidth: 2,
			shadow: { color: "#000000", blur: 4, offsetX: 2, offsetY: 2 },
		};
		expect(CanvasStarNodeSchema.safeParse(full).success).toBe(true);
	});

	it("rejects points below the floor of 3", () => {
		expect(CanvasStarNodeSchema.safeParse({ ...base, points: 2 }).success).toBe(
			false,
		);
	});

	it("rejects a non-integer points count", () => {
		expect(
			CanvasStarNodeSchema.safeParse({ ...base, points: 4.5 }).success,
		).toBe(false);
	});

	it("rejects innerRadiusRatio outside 0..1", () => {
		expect(
			CanvasStarNodeSchema.safeParse({ ...base, innerRadiusRatio: -0.1 })
				.success,
		).toBe(false);
		expect(
			CanvasStarNodeSchema.safeParse({ ...base, innerRadiusRatio: 1.1 })
				.success,
		).toBe(false);
	});

	it("accepts the innerRadiusRatio boundaries 0 and 1", () => {
		expect(
			CanvasStarNodeSchema.safeParse({ ...base, innerRadiusRatio: 0 }).success,
		).toBe(true);
		expect(
			CanvasStarNodeSchema.safeParse({ ...base, innerRadiusRatio: 1 }).success,
		).toBe(true);
	});

	it("round-trips through JSON unchanged", () => {
		const parsed = CanvasStarNodeSchema.parse(JSON.parse(JSON.stringify(base)));
		expect(parsed).toEqual(base);
	});

	it("preserves unknown fields (forward-compat)", () => {
		const withExtra = { ...base, futureField: "keep me" };
		expect(CanvasStarNodeSchema.parse(withExtra)).toEqual(withExtra);
	});
});

describe("BrandTokenRefSchema", () => {
	const colorToken: BrandTokenRef = {
		type: "brand-token",
		tokenType: "color",
		id: "brand.primary",
	};

	it("accepts a valid token for every tokenType", () => {
		for (const tokenType of [
			"color",
			"font",
			"spacing",
			"asset",
			"logo",
		] as const) {
			expect(
				BrandTokenRefSchema.safeParse({
					type: "brand-token",
					tokenType,
					id: "x",
				}).success,
			).toBe(true);
		}
	});

	it("rejects an unknown tokenType", () => {
		expect(
			BrandTokenRefSchema.safeParse({
				type: "brand-token",
				tokenType: "bogus",
				id: "x",
			}).success,
		).toBe(false);
	});

	it("rejects a missing/empty id", () => {
		expect(
			BrandTokenRefSchema.safeParse({ type: "brand-token", tokenType: "color" })
				.success,
		).toBe(false);
		expect(
			BrandTokenRefSchema.safeParse({
				type: "brand-token",
				tokenType: "color",
				id: "",
			}).success,
		).toBe(false);
	});

	it("preserves unknown fields (forward-compat)", () => {
		const withExtra = { ...colorToken, futureField: "keep me" };
		expect(BrandTokenRefSchema.parse(withExtra)).toEqual(withExtra);
	});
});

describe("CanvasFillSchema — brand-token member", () => {
	const token: BrandTokenRef = {
		type: "brand-token",
		tokenType: "color",
		id: "brand.accent",
	};

	it("accepts a brand-token ref alongside string and gradient fills", () => {
		expect(CanvasFillSchema.safeParse(token).success).toBe(true);
		expect(CanvasFillSchema.safeParse("#ff0000").success).toBe(true);
	});

	it("a rect's fill accepts a brand-token ref", () => {
		const rect = { ...makeRect("r1"), fill: token };
		expect(CanvasRectNodeSchema.safeParse(rect).success).toBe(true);
	});
});

describe("fontFamily — brand-token ref", () => {
	const fontToken: BrandTokenRef = {
		type: "brand-token",
		tokenType: "font",
		id: "brand.heading-font",
	};

	it("CanvasTextNodeSchema accepts a token fontFamily", () => {
		const text = { ...makeText("t1", "hi"), fontFamily: fontToken };
		expect(CanvasTextNodeSchema.safeParse(text).success).toBe(true);
	});

	it("a rich-text span accepts a token fontFamily and fill", () => {
		const richText = {
			...makeRichText("rt1"),
			paragraphs: [
				{
					spans: [{ text: "hi", fontFamily: fontToken, fill: fontToken }],
				},
			],
		};
		expect(CanvasRichTextNodeSchema.safeParse(richText).success).toBe(true);
	});
});

describe("assetToken — frame placeholder + image", () => {
	const assetToken: BrandTokenRef = {
		type: "brand-token",
		tokenType: "logo",
		id: "brand.logo",
	};

	it("FramePlaceholderSchema accepts assetToken alongside assetId", () => {
		expect(
			FramePlaceholderSchema.safeParse({ kind: "logo", assetToken }).success,
		).toBe(true);
		expect(
			FramePlaceholderSchema.safeParse({
				kind: "logo",
				assetId: "a1",
				assetToken,
			}).success,
		).toBe(true);
	});

	it("CanvasImageNodeSchema accepts an optional assetToken", () => {
		const image = { ...makeImage("i1", "a1"), assetToken };
		expect(CanvasImageNodeSchema.safeParse(image).success).toBe(true);
	});

	it("round-trips a document with token fills/fonts/assetTokens through JSON unchanged", () => {
		const frame: CanvasFrameNode = {
			...makeFrame("f1", [
				{ ...makeRect("r1"), fill: assetToken },
				{
					...makeText("t1", "hi"),
					fontFamily: { type: "brand-token", tokenType: "font", id: "b.f" },
				},
			]),
			placeholder: { kind: "logo", assetToken },
		};
		const parsed = CanvasFrameNodeSchema.parse(
			JSON.parse(JSON.stringify(frame)),
		);
		expect(parsed).toEqual(frame);
	});
});
