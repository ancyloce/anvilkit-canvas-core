import { describe, expect, it } from "vitest";
import {
	CanvasGroupNodeSchema,
	CanvasIRSchema,
	CanvasImageNodeSchema,
	CanvasLineNodeSchema,
	CanvasNodeSchema,
	CanvasPageSchema,
	CanvasRectNodeSchema,
	CanvasTextNodeSchema,
	CanvasTransformSchema,
} from "../ir-validators.js";
import type {
	CanvasGroupNode,
	CanvasIR,
	CanvasImageNode,
	CanvasNode,
	CanvasPage,
	CanvasRectNode,
	CanvasTextNode,
} from "../types.js";

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

const makePage = (id: string, children: CanvasNode[]): CanvasPage => ({
	id,
	size: { width: 1080, height: 1080, unit: "px" },
	background: { kind: "solid", value: "#ffffff" },
	root: makeGroup(`${id}-root`, children),
});

const makeIR = (pages: CanvasPage[]): CanvasIR => ({
	version: "1",
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

	it("rejects an IR with version other than '1'", () => {
		const ir = makeIR([makePage("p1", [])]);
		const broken = { ...ir, version: "2" as unknown as "1" };
		expect(CanvasIRSchema.safeParse(broken).success).toBe(false);
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
	it("accepts each of the 8 node kinds", () => {
		const nodes: CanvasNode[] = [
			makeGroup("g1", []),
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
