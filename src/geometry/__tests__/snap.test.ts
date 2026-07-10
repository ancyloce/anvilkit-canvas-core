import { describe, expect, it } from "vitest";
import {
	alignRects,
	computeSnap,
	DEFAULT_SNAP_THRESHOLD,
	distributeRects,
	type SnapRect,
} from "../snap.js";

describe("computeSnap — grid only", () => {
	it("snaps top-left to nearest grid line", () => {
		const result = computeSnap({
			candidate: { x: 5, y: 11, width: 20, height: 20 },
			others: [],
			gridSize: 8,
		});
		// 5 → 8 (delta +3); 11 → 8 (delta -3).
		expect(result.dx).toBe(3);
		expect(result.dy).toBe(-3);
		expect(result.guides).toEqual([]);
	});

	it("zero delta when already on grid", () => {
		const result = computeSnap({
			candidate: { x: 16, y: 24, width: 10, height: 10 },
			others: [],
			gridSize: 8,
		});
		expect(result.dx).toBe(0);
		expect(result.dy).toBe(0);
	});

	it("no grid snap when gridSize omitted or 0", () => {
		const a = computeSnap({
			candidate: { x: 5, y: 5, width: 1, height: 1 },
			others: [],
		});
		expect(a).toEqual({ dx: 0, dy: 0, guides: [] });
		const b = computeSnap({
			candidate: { x: 5, y: 5, width: 1, height: 1 },
			others: [],
			gridSize: 0,
		});
		expect(b).toEqual({ dx: 0, dy: 0, guides: [] });
	});
});

describe("computeSnap — edge snap to other nodes", () => {
	const big: SnapRect = { x: 100, y: 0, width: 5, height: 200 };

	it("snaps candidate left to other left within threshold", () => {
		const result = computeSnap({
			candidate: { x: 102, y: 50, width: 10, height: 10 },
			others: [big],
		});
		expect(result.dx).toBe(-2);
		expect(result.guides).toHaveLength(1);
		expect(result.guides[0]).toMatchObject({ axis: "x", position: 100 });
	});

	it("no edge snap when distance exceeds threshold", () => {
		const result = computeSnap({
			candidate: { x: 200, y: 50, width: 10, height: 10 },
			others: [big],
			threshold: 5,
		});
		expect(result.dx).toBe(0);
		expect(result.guides).toEqual([]);
	});

	it("snaps both axes independently and emits two guides", () => {
		const result = computeSnap({
			candidate: { x: 51, y: 49, width: 10, height: 10 },
			others: [{ x: 50, y: 50, width: 20, height: 20 }],
		});
		expect(result.dx).toBe(-1);
		expect(result.dy).toBe(1);
		expect(result.guides).toHaveLength(2);
		expect(result.guides.map((g) => g.axis).sort()).toEqual(["x", "y"]);
	});

	it("picks the smallest delta when multiple matches exist", () => {
		const result = computeSnap({
			candidate: { x: 102, y: 50, width: 10, height: 10 },
			others: [
				{ x: 100, y: 0, width: 5, height: 200 },
				{ x: 101, y: 0, width: 5, height: 200 },
			],
		});
		expect(result.dx).toBe(-1);
		expect(result.guides[0]?.position).toBe(101);
	});

	it("edge snap beats grid snap when both available", () => {
		const result = computeSnap({
			candidate: { x: 9, y: 500, width: 10, height: 10 },
			others: [{ x: 8, y: 0, width: 5, height: 5 }],
			gridSize: 8,
		});
		expect(result.dx).toBe(-1);
		expect(result.dy).toBe(4);
		expect(result.guides).toHaveLength(1);
		expect(result.guides[0]?.axis).toBe("x");
	});

	it("falls back to grid snap when no edge matches on an axis", () => {
		const result = computeSnap({
			candidate: { x: 5, y: 100, width: 10, height: 10 },
			others: [{ x: 200, y: 100, width: 5, height: 5 }],
			gridSize: 8,
			threshold: 4,
		});
		expect(result.dx).toBe(3);
		expect(result.dy).toBe(0);
		expect(result.guides).toHaveLength(1);
		expect(result.guides[0]?.axis).toBe("y");
	});

	it("guide spans the union of candidate + target on the perpendicular axis", () => {
		const result = computeSnap({
			candidate: { x: 100, y: 50, width: 10, height: 10 },
			others: [{ x: 100, y: 200, width: 10, height: 20 }],
		});
		expect(result.guides).toHaveLength(1);
		const g = result.guides[0];
		expect(g?.axis).toBe("x");
		expect(g?.position).toBe(100);
		expect(g?.from.y).toBe(50);
		expect(g?.to.y).toBe(220);
	});
});

describe("computeSnap — default threshold", () => {
	it(`DEFAULT_SNAP_THRESHOLD is ${DEFAULT_SNAP_THRESHOLD}`, () => {
		expect(DEFAULT_SNAP_THRESHOLD).toBe(6);
	});
});

describe("alignRects", () => {
	const rects: SnapRect[] = [
		{ x: 0, y: 0, width: 50, height: 20 },
		{ x: 100, y: 40, width: 30, height: 60 },
	];

	it("aligns left / right edges to the bounding box", () => {
		expect(alignRects(rects, "left")).toEqual([0, -100]);
		expect(alignRects(rects, "right")).toEqual([80, 0]);
	});

	it("aligns top / bottom edges to the bounding box", () => {
		expect(alignRects(rects, "top")).toEqual([0, -40]);
		expect(alignRects(rects, "bottom")).toEqual([80, 0]);
	});

	it("aligns centers to the bounding-box center", () => {
		// bbox center x = (0 + 130) / 2 = 65; r1 center 25 → 40, r2 center 115 → -50
		expect(alignRects(rects, "hcenter")).toEqual([40, -50]);
		// bbox center y = (0 + 100) / 2 = 50; r1 center 10 → 40, r2 center 70 → -20
		expect(alignRects(rects, "vcenter")).toEqual([40, -20]);
	});

	it("returns empty for empty input", () => {
		expect(alignRects([], "left")).toEqual([]);
	});
});

describe("distributeRects", () => {
	it("evens out gaps keeping the ends fixed (index-aligned output)", () => {
		const rects: SnapRect[] = [
			{ x: 0, y: 0, width: 10, height: 10 },
			{ x: 30, y: 0, width: 10, height: 10 },
			{ x: 100, y: 0, width: 10, height: 10 },
		];
		// gap = (110 - 30) / 2 = 40; middle target 50 → delta +20, ends fixed.
		expect(distributeRects(rects, "x")).toEqual([0, 20, 0]);
	});

	it("maps deltas back to original (unsorted) order", () => {
		const rects: SnapRect[] = [
			{ x: 100, y: 0, width: 10, height: 10 }, // last by position
			{ x: 0, y: 0, width: 10, height: 10 }, // first by position
			{ x: 30, y: 0, width: 10, height: 10 }, // middle
		];
		expect(distributeRects(rects, "x")).toEqual([0, 0, 20]);
	});

	it("is a no-op for fewer than 3 rects", () => {
		const rects: SnapRect[] = [
			{ x: 0, y: 0, width: 10, height: 10 },
			{ x: 100, y: 0, width: 10, height: 10 },
		];
		expect(distributeRects(rects, "x")).toEqual([0, 0]);
	});
});
