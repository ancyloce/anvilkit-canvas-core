import { describe, expect, it } from "vitest";
import type {
	CanvasGroupNode,
	CanvasIR,
	CanvasLineNode,
	CanvasNode,
	CanvasRectNode,
	CanvasRichTextNode,
	CanvasTransform,
} from "../../ir/types.js";
import {
	CanvasLineNodeSchema,
	CanvasRectNodeSchema,
	CanvasRichTextNodeSchema,
} from "../../ir/validators.js";
import { serializePageToSvg } from "../svg.js";

const identity: CanvasTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

function ir(children: CanvasNode[]): CanvasIR {
	const root: CanvasGroupNode = {
		id: "root",
		type: "group",
		transform: identity,
		bounds: { width: 300, height: 300 },
		zIndex: 0,
		children,
	};
	return {
		version: "2",
		id: "doc-style",
		title: "Style fixture",
		pages: [
			{
				id: "page-1",
				size: { width: 300, height: 300, unit: "px" },
				background: { kind: "solid", value: "#fff" },
				root,
			},
		],
		assets: {},
		metadata: { createdAt: "T", updatedAt: "T" },
	};
}

async function svgFor(children: CanvasNode[]) {
	return serializePageToSvg(ir(children), "page-1");
}

const baseRect: CanvasRectNode = {
	id: "r1",
	type: "rect",
	transform: identity,
	bounds: { width: 100, height: 50 },
	zIndex: 0,
	fill: "#f00",
	stroke: "#00f",
	strokeWidth: 2,
};

describe("B-03a extended stroke styling", () => {
	it("emits stroke-opacity, dasharray, linecap, linejoin", async () => {
		const { svg } = await svgFor([
			{
				...baseRect,
				strokeOpacity: 0.5,
				strokeDash: [4, 2],
				strokeCap: "round",
				strokeJoin: "bevel",
			},
		]);
		expect(svg).toContain('stroke-opacity="0.5"');
		expect(svg).toContain('stroke-dasharray="4 2"');
		expect(svg).toContain('stroke-linecap="round"');
		expect(svg).toContain('stroke-linejoin="bevel"');
	});

	it("omits the attributes when unset (pre-B-03 output)", async () => {
		const { svg } = await svgFor([baseRect]);
		expect(svg).not.toContain("stroke-dasharray");
		expect(svg).not.toContain("stroke-linecap");
	});

	it("line arrowheads emit markers bound to the stroke color", async () => {
		const line: CanvasLineNode = {
			id: "l1",
			type: "line",
			transform: identity,
			bounds: { width: 100, height: 0 },
			zIndex: 0,
			points: [0, 0, 100, 0],
			stroke: "#123456",
			arrowEnd: "arrow",
		};
		const { svg } = await svgFor([line]);
		expect(svg).toContain('marker-end="url(#arrow-end-l1)"');
		expect(svg).toContain('<marker id="arrow-end-l1"');
		expect(svg).toContain('fill="#123456"');
		expect(svg).not.toContain("marker-start");
	});

	it("schema accepts the new stroke fields and rejects bad enums", () => {
		expect(
			CanvasRectNodeSchema.safeParse({
				...baseRect,
				strokeCap: "round",
				strokeDash: [1, 2],
			}).success,
		).toBe(true);
		expect(
			CanvasLineNodeSchema.safeParse({
				id: "l",
				type: "line",
				transform: identity,
				bounds: { width: 1, height: 1 },
				zIndex: 0,
				points: [0, 0, 1, 1],
				stroke: "#000",
				arrowEnd: "diamond",
			}).success,
		).toBe(false);
	});
});

describe("B-03b per-corner radii", () => {
	it("rect with cornerRadii renders as a path with per-corner arcs", async () => {
		const { svg } = await svgFor([
			{
				...baseRect,
				cornerRadii: {
					topLeft: 10,
					topRight: 0,
					bottomRight: 5,
					bottomLeft: 0,
				},
			},
		]);
		// The only <rect> left is the page background — the node is a <path>.
		expect(svg.match(/<rect/g)).toHaveLength(1);
		expect(svg).toContain("A 10 10 0 0 1");
		expect(svg).toContain("A 5 5 0 0 1");
	});

	it("radii clamp to the half-extents", async () => {
		const { svg } = await svgFor([
			{
				...baseRect,
				bounds: { width: 40, height: 20 },
				cornerRadii: {
					topLeft: 999,
					topRight: 0,
					bottomRight: 0,
					bottomLeft: 0,
				},
			},
		]);
		expect(svg).toContain("A 10 10 0 0 1"); // min(999, 40/2, 20/2) = 10
	});
});

describe("B-03c rich-text strikethrough + sizing", () => {
	const richText: CanvasRichTextNode = {
		id: "t1",
		type: "rich-text",
		transform: identity,
		bounds: { width: 200, height: 40 },
		zIndex: 0,
		width: 200,
		paragraphs: [
			{
				spans: [{ text: "hello", underline: true, strikethrough: true }],
			},
		],
	};

	it("strikethrough combines with underline in text-decoration", async () => {
		const { svg } = await svgFor([richText]);
		expect(svg).toContain('text-decoration="underline line-through"');
	});

	it("schema accepts sizing auto-width and strikethrough", () => {
		expect(
			CanvasRichTextNodeSchema.safeParse({
				...richText,
				sizing: "auto-width",
			}).success,
		).toBe(true);
		expect(
			CanvasRichTextNodeSchema.safeParse({ ...richText, sizing: "fluid" })
				.success,
		).toBe(false);
	});
});
