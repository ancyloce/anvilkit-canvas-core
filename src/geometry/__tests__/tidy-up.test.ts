import { describe, expect, it } from "vitest";
import type { SnapRect } from "../snap.js";
import { tidyUpRects } from "../snap.js";

function apply(rects: readonly SnapRect[]): SnapRect[] {
	const deltas = tidyUpRects(rects);
	return rects.map((r, i) => ({
		...r,
		x: r.x + (deltas[i]?.dx ?? 0),
		y: r.y + (deltas[i]?.dy ?? 0),
	}));
}

describe("tidyUpRects (C-12, FR-072)", () => {
	it("fewer than 2 rects is all zeros", () => {
		expect(tidyUpRects([])).toEqual([]);
		expect(tidyUpRects([{ x: 5, y: 5, width: 10, height: 10 }])).toEqual([
			{ dx: 0, dy: 0 },
		]);
	});

	it("an already-tidy row is a no-op", () => {
		const row: SnapRect[] = [
			{ x: 0, y: 0, width: 10, height: 10 },
			{ x: 14, y: 0, width: 10, height: 10 },
			{ x: 28, y: 0, width: 10, height: 10 },
		];
		expect(tidyUpRects(row)).toEqual([
			{ dx: 0, dy: 0 },
			{ dx: 0, dy: 0 },
			{ dx: 0, dy: 0 },
		]);
	});

	it("snaps a jittered row onto one baseline with the median gap", () => {
		const jittered: SnapRect[] = [
			{ x: 0, y: 1, width: 10, height: 10 },
			{ x: 15, y: -2, width: 10, height: 10 },
			{ x: 27, y: 2, width: 10, height: 10 },
		];
		const tidy = apply(jittered);
		// One row: every y lands on the selection top (-2).
		expect(tidy.every((r) => r.y === -2)).toBe(true);
		// Uniform gaps at the median existing gap.
		const gap1 = (tidy[1]?.x ?? 0) - ((tidy[0]?.x ?? 0) + 10);
		const gap2 = (tidy[2]?.x ?? 0) - ((tidy[1]?.x ?? 0) + 10);
		expect(gap1).toBe(gap2);
	});

	it("clusters two rows and stacks them with a uniform vertical gap", () => {
		const grid: SnapRect[] = [
			// row 1 (unsorted input order on purpose)
			{ x: 22, y: 2, width: 10, height: 10 },
			{ x: 0, y: 0, width: 10, height: 10 },
			// row 2
			{ x: 1, y: 30, width: 10, height: 10 },
			{ x: 25, y: 31, width: 10, height: 10 },
		];
		const tidy = apply(grid);
		const rowYs = [...new Set(tidy.map((r) => r.y))].sort((a, b) => a - b);
		expect(rowYs).toHaveLength(2);
		// Rows start at the selection's left edge.
		expect(Math.min(...tidy.map((r) => r.x))).toBe(0);
		// Index alignment: input order preserved in the output array.
		expect(tidy[1]?.x).toBe(0); // the row-1 leftmost item was index 1
	});

	it("overlapping rects tidy to a non-negative gap", () => {
		const overlapping: SnapRect[] = [
			{ x: 0, y: 0, width: 20, height: 10 },
			{ x: 10, y: 1, width: 20, height: 10 },
			{ x: 18, y: -1, width: 20, height: 10 },
		];
		const tidy = apply(overlapping).sort((a, b) => a.x - b.x);
		const first = tidy[0];
		const second = tidy[1];
		if (!first || !second) throw new Error("fixture");
		expect(second.x).toBeGreaterThanOrEqual(first.x + first.width);
	});
});
