import { describe, expect, it } from "vitest";
import {
	applyMatrix,
	toAffineMatrix,
	transformedBoundsExtent,
} from "../geometry.js";
import type { CanvasTransform } from "../types.js";

const identity: CanvasTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

function round(extent: {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}) {
	return {
		minX: Math.round(extent.minX),
		minY: Math.round(extent.minY),
		maxX: Math.round(extent.maxX),
		maxY: Math.round(extent.maxY),
	};
}

describe("applyMatrix", () => {
	it("maps a point through translate + scale", () => {
		const m = toAffineMatrix({
			...identity,
			x: 10,
			y: 20,
			scaleX: 2,
			scaleY: 3,
		});
		expect(applyMatrix(m, 5, 5).map(Math.round)).toEqual([20, 35]);
	});
});

describe("transformedBoundsExtent", () => {
	it("is the box itself under an identity transform", () => {
		expect(round(transformedBoundsExtent(identity, 100, 40))).toEqual({
			minX: 0,
			minY: 0,
			maxX: 100,
			maxY: 40,
		});
	});

	it("translates the extent", () => {
		expect(
			round(transformedBoundsExtent({ ...identity, x: 50, y: 60 }, 100, 40)),
		).toEqual({ minX: 50, minY: 60, maxX: 150, maxY: 100 });
	});

	it("accounts for a 90° rotation (a 100×40 box becomes 40 wide × 100 tall)", () => {
		const ext = round(
			transformedBoundsExtent({ ...identity, rotation: 90 }, 100, 40),
		);
		expect(ext.maxX - ext.minX).toBe(40);
		expect(ext.maxY - ext.minY).toBe(100);
	});

	it("accounts for scale", () => {
		expect(
			round(
				transformedBoundsExtent(
					{ ...identity, scaleX: 2, scaleY: 0.5 },
					100,
					40,
				),
			),
		).toEqual({ minX: 0, minY: 0, maxX: 200, maxY: 20 });
	});
});
