import { describe, expect, it } from "vitest";
import type { CanvasBounds } from "../../ir/types.js";
import { computePolygonVertices, computeStarVertices } from "../polygon.js";

const square: CanvasBounds = { width: 100, height: 100 };

function distanceFromCenter(
	v: { x: number; y: number },
	bounds: CanvasBounds,
): number {
	return Math.hypot(v.x - bounds.width / 2, v.y - bounds.height / 2);
}

describe("computePolygonVertices", () => {
	it("returns exactly `sides` vertices", () => {
		expect(computePolygonVertices(square, 3)).toHaveLength(3);
		expect(computePolygonVertices(square, 8)).toHaveLength(8);
	});

	it("starts at the top and goes clockwise for a square (a diamond)", () => {
		const v = computePolygonVertices(square, 4);
		expect(v[0]?.x).toBeCloseTo(50);
		expect(v[0]?.y).toBeCloseTo(0);
		expect(v[1]?.x).toBeCloseTo(100);
		expect(v[1]?.y).toBeCloseTo(50);
		expect(v[2]?.x).toBeCloseTo(50);
		expect(v[2]?.y).toBeCloseTo(100);
		expect(v[3]?.x).toBeCloseTo(0);
		expect(v[3]?.y).toBeCloseTo(50);
	});

	it("every vertex sits exactly on the inscribed radius for a square box", () => {
		const v = computePolygonVertices(square, 6);
		for (const p of v) {
			expect(distanceFromCenter(p, square)).toBeCloseTo(50);
		}
	});

	it("stretches along the wider axis for a non-square box", () => {
		const wide: CanvasBounds = { width: 200, height: 100 };
		const v = computePolygonVertices(wide, 4);
		// Right vertex (angle 0) reaches the wide box's horizontal extent.
		expect(v[1]?.x).toBeCloseTo(200);
		expect(v[1]?.y).toBeCloseTo(50);
	});
});

describe("computeStarVertices", () => {
	it("returns 2 * points vertices, alternating outer/inner", () => {
		expect(computeStarVertices(square, 5, 0.5)).toHaveLength(10);
		expect(computeStarVertices(square, 3, 0.5)).toHaveLength(6);
	});

	it("outer vertices sit on the full radius, inner on innerRadiusRatio * radius", () => {
		const v = computeStarVertices(square, 5, 0.4);
		for (const [i, p] of v.entries()) {
			const dist = distanceFromCenter(p, square);
			if (i % 2 === 0) {
				expect(dist).toBeCloseTo(50);
			} else {
				expect(dist).toBeCloseTo(20); // 50 * 0.4
			}
		}
	});

	it("the first (outer) vertex starts at the top, matching computePolygonVertices", () => {
		const star = computeStarVertices(square, 5, 0.5);
		const polygon = computePolygonVertices(square, 5);
		expect(star[0]?.x).toBeCloseTo(polygon[0]?.x as number);
		expect(star[0]?.y).toBeCloseTo(polygon[0]?.y as number);
	});

	it("innerRadiusRatio 0 collapses inner vertices to the center", () => {
		const v = computeStarVertices(square, 4, 0);
		for (const [i, p] of v.entries()) {
			if (i % 2 === 1) {
				expect(p.x).toBeCloseTo(50);
				expect(p.y).toBeCloseTo(50);
			}
		}
	});

	it("innerRadiusRatio 1 makes every vertex equidistant from center (a regular 2*points-gon)", () => {
		const v = computeStarVertices(square, 5, 1);
		for (const p of v) {
			expect(distanceFromCenter(p, square)).toBeCloseTo(50);
		}
	});
});
