import { describe, expect, it } from "vitest";
import {
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
	createText,
} from "../builders.js";
import type { BrandTokenRef } from "../types.js";
import {
	CanvasEllipseNodeSchema,
	CanvasFrameNodeSchema,
	CanvasGroupNodeSchema,
	CanvasImageNodeSchema,
	CanvasIRSchema,
	CanvasLineNodeSchema,
	CanvasPageSchema,
	CanvasPathNodeSchema,
	CanvasPolygonNodeSchema,
	CanvasRectNodeSchema,
	CanvasRichTextNodeSchema,
	CanvasStarNodeSchema,
	CanvasTextNodeSchema,
} from "../validators.js";

describe("createCanvasIR", () => {
	it("returns a schema-valid IR with no args", () => {
		const ir = createCanvasIR();
		expect(CanvasIRSchema.safeParse(ir).success).toBe(true);
		expect(ir.version).toBe("2");
		expect(ir.pages).toHaveLength(1);
		expect(ir.title).toBe("Untitled");
	});

	it("uses the injected clock", () => {
		const ir = createCanvasIR({ now: () => "2026-01-01T00:00:00.000Z" });
		expect(ir.metadata.createdAt).toBe("2026-01-01T00:00:00.000Z");
		expect(ir.metadata.updatedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("produces unique ids across successive calls", () => {
		const a = createCanvasIR();
		const b = createCanvasIR();
		expect(a.id).not.toBe(b.id);
		expect(a.pages[0]?.id).not.toBe(b.pages[0]?.id);
	});

	it("accepts a user-supplied page list", () => {
		const customPage = createPage({ name: "Hero" });
		const ir = createCanvasIR({ pages: [customPage] });
		expect(ir.pages).toHaveLength(1);
		expect(ir.pages[0]?.name).toBe("Hero");
	});
});

describe("createPage", () => {
	it("returns a schema-valid page with default size + background + root group", () => {
		const page = createPage();
		expect(CanvasPageSchema.safeParse(page).success).toBe(true);
		expect(page.size).toEqual({ width: 1080, height: 1080, unit: "px" });
		expect(page.background).toEqual({ kind: "solid", value: "#ffffff" });
		expect(page.root.type).toBe("group");
		expect(page.root.bounds).toEqual({ width: 1080, height: 1080 });
	});
});

describe("createGroup", () => {
	it("returns a schema-valid empty group with default transform", () => {
		const g = createGroup({ bounds: { width: 100, height: 100 } });
		expect(CanvasGroupNodeSchema.safeParse(g).success).toBe(true);
		expect(g.transform).toEqual({
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});
		expect(g.children).toEqual([]);
		expect(g.zIndex).toBe(0);
	});

	it("merges partial transforms with the identity default", () => {
		const g = createGroup({ transform: { x: 10, rotation: 45 } });
		expect(g.transform).toEqual({
			x: 10,
			y: 0,
			rotation: 45,
			scaleX: 1,
			scaleY: 1,
		});
	});
});

describe("createFrame", () => {
	it("returns a schema-valid empty frame with default transform", () => {
		const f = createFrame({ bounds: { width: 400, height: 300 } });
		expect(CanvasFrameNodeSchema.safeParse(f).success).toBe(true);
		expect(f.type).toBe("frame");
		expect(f.transform).toEqual({
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});
		expect(f.bounds).toEqual({ width: 400, height: 300 });
		expect(f.children).toEqual([]);
		expect(f.zIndex).toBe(0);
	});

	it("omits every optional field rather than emitting `undefined` values", () => {
		const f = createFrame({ bounds: { width: 10, height: 10 } });
		expect("clip" in f).toBe(false);
		expect("background" in f).toBe(false);
		expect("placeholder" in f).toBe(false);
		expect("radius" in f).toBe(false);
		expect("name" in f).toBe(false);
	});

	it("carries children, clip, background, placeholder and radius through", () => {
		const child = createRect({ bounds: { width: 10, height: 10 } });
		const f = createFrame({
			id: "f1",
			name: "Hero",
			bounds: { width: 400, height: 300 },
			children: [child],
			clip: true,
			background: "#ff0000",
			placeholder: { kind: "image" },
			radius: 8,
		});
		expect(CanvasFrameNodeSchema.safeParse(f).success).toBe(true);
		expect(f.children).toEqual([child]);
		expect(f.clip).toBe(true);
		expect(f.background).toBe("#ff0000");
		expect(f.placeholder).toEqual({ kind: "image" });
		expect(f.radius).toBe(8);
		expect(f.name).toBe("Hero");
	});

	it("merges partial transforms with the identity default", () => {
		const f = createFrame({
			bounds: { width: 10, height: 10 },
			transform: { x: 10, rotation: 45 },
		});
		expect(f.transform).toEqual({
			x: 10,
			y: 0,
			rotation: 45,
			scaleX: 1,
			scaleY: 1,
		});
	});

	it("generates a unique id when none is supplied", () => {
		const a = createFrame({ bounds: { width: 1, height: 1 } });
		const b = createFrame({ bounds: { width: 1, height: 1 } });
		expect(a.id).not.toBe(b.id);
	});
});

describe("createRect / createEllipse", () => {
	it("createRect returns a schema-valid rect", () => {
		const r = createRect({ bounds: { width: 50, height: 30 }, fill: "#abc" });
		expect(CanvasRectNodeSchema.safeParse(r).success).toBe(true);
		expect(r.fill).toBe("#abc");
		expect(r.transform.scaleX).toBe(1);
	});

	it("createEllipse returns a schema-valid ellipse", () => {
		const e = createEllipse({ bounds: { width: 40, height: 40 } });
		expect(CanvasEllipseNodeSchema.safeParse(e).success).toBe(true);
	});
});

describe("createPolygon / createStar", () => {
	it("createPolygon returns a schema-valid polygon, defaulting sides to 5", () => {
		const p = createPolygon({ bounds: { width: 50, height: 50 } });
		expect(CanvasPolygonNodeSchema.safeParse(p).success).toBe(true);
		expect(p.sides).toBe(5);
	});

	it("createPolygon honors a caller-provided sides count", () => {
		const p = createPolygon({ bounds: { width: 50, height: 50 }, sides: 8 });
		expect(p.sides).toBe(8);
	});

	it("createStar returns a schema-valid star, defaulting points/innerRadiusRatio", () => {
		const s = createStar({ bounds: { width: 50, height: 50 } });
		expect(CanvasStarNodeSchema.safeParse(s).success).toBe(true);
		expect(s.points).toBe(5);
		expect(s.innerRadiusRatio).toBe(0.5);
	});

	it("createStar honors caller-provided points/innerRadiusRatio/fill", () => {
		const s = createStar({
			bounds: { width: 50, height: 50 },
			points: 7,
			innerRadiusRatio: 0.35,
			fill: "#abc",
		});
		expect(s.points).toBe(7);
		expect(s.innerRadiusRatio).toBe(0.35);
		expect(s.fill).toBe("#abc");
	});
});

describe("createLine", () => {
	it("derives bounds from points and defaults stroke", () => {
		const l = createLine({ points: [0, 0, 100, 50] });
		expect(CanvasLineNodeSchema.safeParse(l).success).toBe(true);
		expect(l.bounds).toEqual({ width: 100, height: 50 });
		expect(l.stroke).toBe("#000000");
	});

	it("honors a caller-provided bounds override", () => {
		const l = createLine({
			points: [0, 0, 100, 50],
			bounds: { width: 200, height: 200 },
		});
		expect(l.bounds).toEqual({ width: 200, height: 200 });
	});
});

describe("createPath", () => {
	it("returns a schema-valid path with just bounds + d", () => {
		const p = createPath({
			bounds: { width: 50, height: 50 },
			d: "M 0 0 L 10 10 Z",
		});
		expect(CanvasPathNodeSchema.safeParse(p).success).toBe(true);
		expect(p.type).toBe("path");
		expect(p.d).toBe("M 0 0 L 10 10 Z");
		expect(p.transform).toEqual({
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});
	});

	it("carries fill / stroke / strokeWidth when provided", () => {
		const p = createPath({
			id: "path-1",
			bounds: { width: 20, height: 20 },
			d: "M 0 0 L 5 5",
			fill: "#ff0000",
			stroke: "#00ff00",
			strokeWidth: 3,
		});
		expect(CanvasPathNodeSchema.safeParse(p).success).toBe(true);
		expect(p.id).toBe("path-1");
		expect(p.fill).toBe("#ff0000");
		expect(p.stroke).toBe("#00ff00");
		expect(p.strokeWidth).toBe(3);
	});

	it("omits optional keys when not provided", () => {
		const p = createPath({ bounds: { width: 10, height: 10 }, d: "M 0 0" });
		expect("fill" in p).toBe(false);
		expect("stroke" in p).toBe(false);
		expect("strokeWidth" in p).toBe(false);
	});
});

describe("createText", () => {
	it("defaults fontFamily, fontSize, and fill", () => {
		const t = createText({
			bounds: { width: 100, height: 24 },
			text: "Hello",
		});
		expect(CanvasTextNodeSchema.safeParse(t).success).toBe(true);
		expect(t.fontFamily).toBe("Inter");
		expect(t.fontSize).toBe(16);
		expect(t.fill).toBe("#000000");
		expect(t.text).toBe("Hello");
	});

	it("accepts a brand-token ref for fontFamily and fill", () => {
		const fontToken: BrandTokenRef = {
			type: "brand-token",
			tokenType: "font",
			id: "b.heading",
		};
		const fillToken: BrandTokenRef = {
			type: "brand-token",
			tokenType: "color",
			id: "b.ink",
		};
		const t = createText({
			bounds: { width: 100, height: 24 },
			text: "Hello",
			fontFamily: fontToken,
			fill: fillToken,
		});
		expect(CanvasTextNodeSchema.safeParse(t).success).toBe(true);
		expect(t.fontFamily).toEqual(fontToken);
		expect(t.fill).toEqual(fillToken);
	});
});

describe("createImage", () => {
	it("returns a schema-valid image with just bounds + assetId", () => {
		const i = createImage({
			bounds: { width: 300, height: 200 },
			assetId: "asset-1",
		});
		expect(CanvasImageNodeSchema.safeParse(i).success).toBe(true);
		expect(i.assetId).toBe("asset-1");
	});

	it("accepts an optional brand-token assetToken", () => {
		const assetToken: BrandTokenRef = {
			type: "brand-token",
			tokenType: "logo",
			id: "b.logo",
		};
		const i = createImage({
			bounds: { width: 300, height: 200 },
			assetId: "asset-1",
			assetToken,
		});
		expect(CanvasImageNodeSchema.safeParse(i).success).toBe(true);
		expect(i.assetToken).toEqual(assetToken);
	});

	it("omits assetToken entirely when not provided (no stray undefined key)", () => {
		const i = createImage({
			bounds: { width: 300, height: 200 },
			assetId: "asset-1",
		});
		expect("assetToken" in i).toBe(false);
	});
});

describe("createRect / createPolygon / createStar / createPath — brand-token fill", () => {
	const fillToken: BrandTokenRef = {
		type: "brand-token",
		tokenType: "color",
		id: "b.surface",
	};

	it("createRect accepts a brand-token fill", () => {
		const r = createRect({
			bounds: { width: 10, height: 10 },
			fill: fillToken,
		});
		expect(CanvasRectNodeSchema.safeParse(r).success).toBe(true);
		expect(r.fill).toEqual(fillToken);
	});

	it("createPolygon accepts a brand-token fill", () => {
		const p = createPolygon({
			bounds: { width: 10, height: 10 },
			fill: fillToken,
		});
		expect(CanvasPolygonNodeSchema.safeParse(p).success).toBe(true);
		expect(p.fill).toEqual(fillToken);
	});

	it("createStar accepts a brand-token fill", () => {
		const s = createStar({
			bounds: { width: 10, height: 10 },
			fill: fillToken,
		});
		expect(CanvasStarNodeSchema.safeParse(s).success).toBe(true);
		expect(s.fill).toEqual(fillToken);
	});

	it("createPath accepts a brand-token fill", () => {
		const p = createPath({
			bounds: { width: 10, height: 10 },
			d: "M 0 0 L 1 1",
			fill: fillToken,
		});
		expect(CanvasPathNodeSchema.safeParse(p).success).toBe(true);
		expect(p.fill).toEqual(fillToken);
	});
});

describe("createRichText", () => {
	it("produces a schema-valid node from bounds alone", () => {
		const rt = createRichText({ bounds: { width: 200, height: 60 } });
		expect(CanvasRichTextNodeSchema.safeParse(rt).success).toBe(true);
		expect(rt.type).toBe("rich-text");
		expect(rt.zIndex).toBe(0);
	});

	// An empty `paragraphs: []` has no caret position, so an editor would have to
	// special-case it before the user can type. One empty paragraph is the
	// natural "empty text block".
	it("defaults to a single empty paragraph, not an empty paragraph list", () => {
		expect(
			createRichText({ bounds: { width: 10, height: 10 } }).paragraphs,
		).toEqual([{ spans: [] }]);
	});

	it("defaults the wrap width to bounds.width", () => {
		expect(createRichText({ bounds: { width: 320, height: 60 } }).width).toBe(
			320,
		);
	});

	it("lets width diverge from bounds.width when asked", () => {
		const rt = createRichText({
			bounds: { width: 320, height: 60 },
			width: 200,
		});
		expect(rt.width).toBe(200);
		expect(rt.bounds.width).toBe(320);
	});

	it("omits every optional field rather than emitting `undefined` values", () => {
		const rt = createRichText({ bounds: { width: 10, height: 10 } });
		const keys = Object.keys(rt);
		expect(keys).not.toContain("name");
		expect(keys).not.toContain("height");
		expect(keys).not.toContain("overflow");
		expect(keys).not.toContain("wrap");
		// JSON round-trip is the real contract — an explicit `undefined` would be
		// dropped by JSON but would still differ under a deep-equal comparison.
		expect(JSON.parse(JSON.stringify(rt))).toEqual(rt);
	});

	it("carries every field through", () => {
		const rt = createRichText({
			id: "rt-1",
			name: "Heading",
			transform: { x: 5, y: 6 },
			bounds: { width: 200, height: 60 },
			zIndex: 3,
			width: 180,
			height: 50,
			overflow: "ellipsis",
			wrap: "character",
			paragraphs: [{ align: "center", spans: [{ text: "hi" }] }],
		});
		expect(rt).toMatchObject({
			id: "rt-1",
			name: "Heading",
			zIndex: 3,
			width: 180,
			height: 50,
			overflow: "ellipsis",
			wrap: "character",
		});
		expect(rt.transform).toEqual({
			x: 5,
			y: 6,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});
		expect(rt.paragraphs[0]?.spans[0]?.text).toBe("hi");
	});

	it("generates a unique id when none is given", () => {
		const a = createRichText({ bounds: { width: 10, height: 10 } });
		const b = createRichText({ bounds: { width: 10, height: 10 } });
		expect(a.id).not.toBe(b.id);
		expect(a.id).toBeTruthy();
	});
});
