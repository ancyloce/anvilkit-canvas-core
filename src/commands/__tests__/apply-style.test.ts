import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createImage,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import type { CanvasIR, CanvasNode, CanvasRectNode } from "../../ir/types.js";
import { findNode } from "../../ir/walkers.js";
import {
	type CanvasNodeStyle,
	computeStylePatch,
	extractNodeStyle,
} from "../apply-style.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";

const FIXED_TS = "2026-05-20T00:00:00.000Z";

function makeIR(children: CanvasNode[]): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({ id: "root", bounds: page.root.bounds, children });
	return createCanvasIR({ id: "ir", pages: [page], now: () => FIXED_TS });
}

const STYLED_RECT = (): CanvasRectNode => ({
	...createRect({
		id: "src",
		bounds: { width: 10, height: 10 },
		fill: "#ff0000",
	}),
	stroke: "#00ff00",
	strokeWidth: 3,
	opacity: 0.5,
	blendMode: "multiply",
	radius: 8,
	shadow: { color: "#000000", blur: 4, offsetX: 2, offsetY: 2 },
});

describe("extractNodeStyle (FR-120)", () => {
	it("extracts appearance only, lifting legacy shadow into effects", () => {
		const style = extractNodeStyle(STYLED_RECT());
		expect(style).toEqual({
			fill: "#ff0000",
			stroke: "#00ff00",
			strokeWidth: 3,
			opacity: 0.5,
			blendMode: "multiply",
			radius: 8,
			effects: [
				{
					type: "drop-shadow",
					color: "#000000",
					blur: 4,
					offsetX: 2,
					offsetY: 2,
				},
			],
		});
		// Never geometry, id, or content.
		expect(style).not.toHaveProperty("id");
		expect(style).not.toHaveProperty("transform");
		expect(style).not.toHaveProperty("bounds");
	});

	it("a frame's background extracts as fill; a text node extracts typography", () => {
		const frame = {
			...createFrame({ id: "f", bounds: { width: 10, height: 10 } }),
			background: "#123456",
		};
		expect(extractNodeStyle(frame).fill).toBe("#123456");
		const text = createText({
			id: "t",
			text: "Hi",
			fontFamily: "Inter",
			fontSize: 24,
			fill: "#000",
			bounds: { width: 100, height: 30 },
		});
		const style = extractNodeStyle(text);
		expect(style.fontFamily).toBe("Inter");
		expect(style.fontSize).toBe(24);
		expect(style).not.toHaveProperty("text");
	});
});

describe("computeStylePatch (FR-121 compatibility matrix)", () => {
	it("splits applied vs ignored keys for an image target", () => {
		const image = createImage({
			id: "img",
			assetId: "a1",
			bounds: { width: 10, height: 10 },
		});
		const style = extractNodeStyle(STYLED_RECT());
		const { applied, ignored, patch } = computeStylePatch(image, style);
		expect(applied.sort()).toEqual(["blendMode", "opacity"]);
		expect(ignored.sort()).toEqual([
			"effects",
			"fill",
			"radius",
			"stroke",
			"strokeWidth",
		]);
		expect(patch).toEqual({ opacity: 0.5, blendMode: "multiply" });
	});

	it("applying effects clears a legacy shadow on the target", () => {
		const target = {
			...createRect({ id: "t", bounds: { width: 5, height: 5 } }),
			shadow: { color: "#111111", blur: 9, offsetX: 0, offsetY: 0 },
		};
		const { patch } = computeStylePatch(target, {
			effects: [
				{
					type: "drop-shadow",
					color: "#222222",
					blur: 1,
					offsetX: 1,
					offsetY: 1,
				},
			],
		});
		expect(patch.effects).toBeDefined();
		expect("shadow" in patch && patch.shadow === undefined).toBe(true);
	});

	it("fill routes to background on a frame target", () => {
		const frame = createFrame({ id: "f", bounds: { width: 10, height: 10 } });
		const { patch, applied } = computeStylePatch(frame, { fill: "#abcdef" });
		expect(patch).toEqual({ background: "#abcdef" });
		expect(applied).toEqual(["fill"]);
	});
});

describe("node.applyStyle command (C-05)", () => {
	it("applies compatible keys and the inverse restores priors exactly", () => {
		const source = STYLED_RECT();
		const target = createRect({
			id: "dst",
			bounds: { width: 20, height: 20 },
			fill: "#0000ff",
		});
		const ir0 = makeIR([source, target]);
		const { ir: ir1, inverse } = applyCommand(ir0, {
			type: "node.applyStyle",
			nodeId: "dst",
			style: extractNodeStyle(source),
		});
		const dst = findNode(ir1, "dst")?.node as CanvasRectNode;
		expect(dst.fill).toBe("#ff0000");
		expect(dst.stroke).toBe("#00ff00");
		expect(dst.radius).toBe(8);
		expect(dst.effects).toHaveLength(1);
		// Geometry untouched.
		expect(dst.bounds).toEqual({ width: 20, height: 20 });
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});

	it("a fully-incompatible payload is a reported no-op, not an error", () => {
		const group = createGroup({ id: "g", bounds: { width: 10, height: 10 } });
		const ir0 = makeIR([group]);
		const style: CanvasNodeStyle = { fill: "#ff0000", radius: 4 };
		const { ir: ir1 } = applyCommand(ir0, {
			type: "node.applyStyle",
			nodeId: "g",
			style,
		});
		expect(JSON.stringify(ir1)).toBe(JSON.stringify(ir0));
	});

	it("respects enforceLocked", () => {
		const target = {
			...createRect({ id: "locked", bounds: { width: 5, height: 5 } }),
			locked: true,
		};
		const ir0 = makeIR([target]);
		let code: string | null = null;
		try {
			applyCommand(
				ir0,
				{ type: "node.applyStyle", nodeId: "locked", style: { fill: "#fff" } },
				{ enforceLocked: true },
			);
		} catch (err) {
			code = err instanceof CanvasCommandError ? err.code : "unexpected";
		}
		expect(code).toBe("node-locked");
	});

	it("multi-node paste as a batch undoes in one step", () => {
		const a = createRect({ id: "a", bounds: { width: 5, height: 5 } });
		const b = createRect({ id: "b", bounds: { width: 5, height: 5 } });
		const ir0 = makeIR([a, b]);
		const style: CanvasNodeStyle = { fill: "#123123" };
		const { ir: ir1, inverse } = applyCommand(ir0, {
			type: "batch",
			commands: [
				{ type: "node.applyStyle", nodeId: "a", style },
				{ type: "node.applyStyle", nodeId: "b", style },
			],
		});
		const rectA = findNode(ir1, "a")?.node as CanvasRectNode;
		const rectB = findNode(ir1, "b")?.node as CanvasRectNode;
		expect(rectA.fill).toBe("#123123");
		expect(rectB.fill).toBe("#123123");
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(JSON.stringify(ir2.pages)).toBe(JSON.stringify(ir0.pages));
	});
});
