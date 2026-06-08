import { describe, expect, it } from "vitest";
import {
	type Aabb,
	hitTest,
	marqueeHits,
	nodeWorldAabb,
	pointInNode,
} from "../hit-test.js";
import { createRect } from "../ir-builders.js";

describe("pointInNode", () => {
	it("tests an axis-aligned box", () => {
		const r = createRect({
			transform: { x: 10, y: 10 },
			bounds: { width: 100, height: 50 },
		});
		expect(pointInNode(r, { x: 50, y: 30 })).toBe(true);
		expect(pointInNode(r, { x: 5, y: 30 })).toBe(false); // left of x=10
		expect(pointInNode(r, { x: 120, y: 30 })).toBe(false); // right of x=110
	});

	it("is rotation-aware (where the naive AABB is wrong)", () => {
		// 100×40 box rotated 90° about its local origin → occupies x∈[-40,0], y∈[0,100].
		const r = createRect({
			transform: { rotation: 90 },
			bounds: { width: 100, height: 40 },
		});
		// True visual center maps to local (50,20): inside.
		expect(pointInNode(r, { x: -20, y: 50 })).toBe(true);
		// (50,20) is inside the *naive* unrotated AABB but outside the rotated box.
		expect(pointInNode(r, { x: 50, y: 20 })).toBe(false);
	});

	it("returns false for a degenerate zero-scale node", () => {
		const r = createRect({
			transform: { scaleX: 0 },
			bounds: { width: 100, height: 50 },
		});
		expect(pointInNode(r, { x: 0, y: 25 })).toBe(false);
	});
});

describe("nodeWorldAabb", () => {
	it("matches the box under an identity transform", () => {
		const r = createRect({
			transform: { x: 10, y: 20 },
			bounds: { width: 100, height: 40 },
		});
		expect(nodeWorldAabb(r)).toEqual({
			minX: 10,
			minY: 20,
			maxX: 110,
			maxY: 60,
		});
	});

	it("encloses a rotated box (swaps extents at 90°)", () => {
		const r = createRect({
			transform: { rotation: 90 },
			bounds: { width: 100, height: 40 },
		});
		const aabb = nodeWorldAabb(r);
		expect(aabb.maxX - aabb.minX).toBeCloseTo(40, 6);
		expect(aabb.maxY - aabb.minY).toBeCloseTo(100, 6);
	});
});

describe("hitTest", () => {
	const a = createRect({ bounds: { width: 100, height: 100 } });
	const b = createRect({ bounds: { width: 100, height: 100 } });

	it("returns the top-most (last) match", () => {
		expect(hitTest([a, b], { x: 50, y: 50 })).toBe(b);
	});

	it("returns null when nothing is hit", () => {
		expect(hitTest([a, b], { x: 500, y: 500 })).toBeNull();
	});

	it("skips locked and invisible nodes when asked", () => {
		const lockedB = { ...b, locked: true };
		expect(hitTest([a, lockedB], { x: 50, y: 50 }, { skipLocked: true })).toBe(
			a,
		);
		const hiddenB = { ...b, visible: false };
		expect(
			hitTest([a, hiddenB], { x: 50, y: 50 }, { skipInvisible: true }),
		).toBe(a);
	});
});

describe("marqueeHits", () => {
	const r1 = createRect({ bounds: { width: 50, height: 50 } }); // AABB 0..50
	const r2 = createRect({
		transform: { x: 100, y: 100 },
		bounds: { width: 50, height: 50 },
	}); // AABB 100..150

	it("selects nodes overlapping the marquee", () => {
		const marquee: Aabb = { minX: -10, minY: -10, maxX: 60, maxY: 60 };
		expect(marqueeHits([r1, r2], marquee).map((n) => n.id)).toEqual([r1.id]);
	});

	it("contained mode requires full enclosure", () => {
		const big: Aabb = { minX: -10, minY: -10, maxX: 200, maxY: 200 };
		expect(marqueeHits([r1, r2], big, { contained: true })).toHaveLength(2);
		const partial: Aabb = { minX: 25, minY: 25, maxX: 200, maxY: 200 };
		expect(
			marqueeHits([r1, r2], partial, { contained: true }).map((n) => n.id),
		).toEqual([r2.id]);
	});

	it("skips locked nodes", () => {
		const lockedR1 = { ...r1, locked: true };
		const marquee: Aabb = { minX: -10, minY: -10, maxX: 200, maxY: 200 };
		expect(
			marqueeHits([lockedR1, r2], marquee, { skipLocked: true }).map(
				(n) => n.id,
			),
		).toEqual([r2.id]);
	});
});
