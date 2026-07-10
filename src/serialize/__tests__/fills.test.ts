import { describe, expect, it } from "vitest";
import { createCanvasIR, createPage } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import { CanvasRectNodeSchema } from "../../ir/validators.js";
import { serializePageToSvg } from "../svg.js";

const baseRect = {
	id: "r",
	type: "rect",
	transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
	bounds: { width: 10, height: 10 },
	zIndex: 0,
};

describe("gradient + shadow fills", () => {
	it("still parses a plain string fill (back-compat)", () => {
		expect(() =>
			CanvasRectNodeSchema.parse({ ...baseRect, fill: "#ff0000" }),
		).not.toThrow();
	});

	it("parses a gradient fill + shadow", () => {
		const parsed = CanvasRectNodeSchema.parse({
			...baseRect,
			fill: {
				kind: "linear",
				stops: [
					{ offset: 0, color: "#ff0000" },
					{ offset: 1, color: "#0000ff" },
				],
				from: { x: 0, y: 0 },
				to: { x: 1, y: 1 },
			},
			shadow: { color: "#000000", blur: 4, offsetX: 2, offsetY: 2 },
		}) as { fill: unknown; shadow: unknown };
		expect(parsed.fill).toMatchObject({ kind: "linear" });
		expect(parsed.shadow).toMatchObject({ blur: 4 });
	});

	it("SVG emits a gradient fill as <defs> and a shadow <filter>", async () => {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "ir", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: {
				...baseRect,
				id: "r1",
				fill: {
					kind: "linear",
					stops: [
						{ offset: 0, color: "#ff0000" },
						{ offset: 1, color: "#0000ff" },
					],
					from: { x: 0, y: 0 },
					to: { x: 1, y: 1 },
				},
				shadow: { color: "#000000", blur: 4, offsetX: 2, offsetY: 2 },
			} as never,
		});
		const { svg } = await serializePageToSvg(ir, "p1");
		expect(svg).toContain("<linearGradient");
		expect(svg).toContain('stop-color="#ff0000"');
		expect(svg).toContain('fill="url(#grad-r1)"');
		expect(svg).toContain("<feDropShadow");
		expect(svg).toContain('filter="url(#shadow-r1)"');
	});

	it("SVG emits a radial gradient", async () => {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({ id: "ir", title: "t", pages: [page] });
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: {
				...baseRect,
				id: "r2",
				fill: {
					kind: "radial",
					stops: [{ offset: 0, color: "#00ff00" }],
					from: { x: 0.5, y: 0.5 },
					to: { x: 1, y: 1 },
				},
			} as never,
		});
		const { svg } = await serializePageToSvg(ir, "p1");
		expect(svg).toContain("<radialGradient");
		expect(svg).toContain('fill="url(#grad-r2)"');
	});
});
