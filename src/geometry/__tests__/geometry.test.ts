import { describe, expect, it } from "vitest";
import type { CanvasTransform } from "../../ir/types.js";
import {
	type AffineMatrix,
	applyMatrix,
	decomposeMatrix,
	invertMatrix,
	multiplyMatrix,
	toAffineMatrix,
	transformedBoundsExtent,
} from "../affine.js";

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

function expectMatrixClose(a: AffineMatrix, b: AffineMatrix, digits = 9) {
	for (let i = 0; i < 6; i++) {
		expect(a[i]).toBeCloseTo(b[i]!, digits);
	}
}

describe("multiplyMatrix", () => {
	it("composes so the result applies m2 first, then m1", () => {
		const m1 = toAffineMatrix({ ...identity, x: 10, y: 20 });
		const m2 = toAffineMatrix({ ...identity, scaleX: 2, scaleY: 3 });
		const composed = multiplyMatrix(m1, m2);
		// applyMatrix(composed, p) === applyMatrix(m1, applyMatrix(m2, p))
		const [cx, cy] = applyMatrix(composed, 5, 7);
		const [ix, iy] = applyMatrix(m2, 5, 7);
		const [ex, ey] = applyMatrix(m1, ix, iy);
		expect(cx).toBeCloseTo(ex, 9);
		expect(cy).toBeCloseTo(ey, 9);
	});

	it("is identity-neutral", () => {
		const id: AffineMatrix = [1, 0, 0, 1, 0, 0];
		const m = toAffineMatrix({ ...identity, x: 3, rotation: 30, scaleX: 2 });
		expectMatrixClose(multiplyMatrix(m, id), m);
		expectMatrixClose(multiplyMatrix(id, m), m);
	});
});

describe("invertMatrix", () => {
	it("inverse composed with the original is the identity", () => {
		const m = toAffineMatrix({
			...identity,
			x: 12,
			y: -8,
			rotation: 37,
			scaleX: 2,
			scaleY: 0.5,
		});
		expectMatrixClose(multiplyMatrix(invertMatrix(m), m), [1, 0, 0, 1, 0, 0]);
		expectMatrixClose(multiplyMatrix(m, invertMatrix(m)), [1, 0, 0, 1, 0, 0]);
	});

	it("round-trips a point", () => {
		const m = toAffineMatrix({ ...identity, x: 5, rotation: 20, scaleX: 1.5 });
		const inv = invertMatrix(m);
		const [wx, wy] = applyMatrix(m, 9, 4);
		const [bx, by] = applyMatrix(inv, wx, wy);
		expect(bx).toBeCloseTo(9, 9);
		expect(by).toBeCloseTo(4, 9);
	});

	it("throws on a singular (zero-scale) matrix", () => {
		const m = toAffineMatrix({ ...identity, scaleX: 0 });
		expect(() => invertMatrix(m)).toThrow(/singular/);
	});
});

describe("decomposeMatrix", () => {
	it("round-trips translate + rotate + scale params", () => {
		const t: CanvasTransform = {
			x: 25,
			y: -13,
			rotation: 42,
			scaleX: 1.8,
			scaleY: 0.6,
		};
		const d = decomposeMatrix(toAffineMatrix(t));
		expect(d.x).toBeCloseTo(t.x, 9);
		expect(d.y).toBeCloseTo(t.y, 9);
		expect(d.rotation).toBeCloseTo(t.rotation, 9);
		expect(d.scaleX).toBeCloseTo(t.scaleX, 9);
		expect(d.scaleY).toBeCloseTo(t.scaleY, 9);
		expect(d.skewX).toBeCloseTo(0, 9);
	});

	it("round-trips a skewX shear at the matrix level", () => {
		const t: CanvasTransform = {
			x: 4,
			y: 4,
			rotation: 15,
			scaleX: 1.2,
			scaleY: 0.9,
			skewX: 0.5,
		};
		const m = toAffineMatrix(t);
		// Recomposing the decomposition reproduces the original matrix.
		expectMatrixClose(toAffineMatrix({ ...decomposeMatrix(m), skewY: 0 }), m);
	});

	it("reports identity for the identity matrix", () => {
		const d = decomposeMatrix([1, 0, 0, 1, 0, 0]);
		expect(d).toEqual({
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
			skewX: 0,
		});
	});
});
