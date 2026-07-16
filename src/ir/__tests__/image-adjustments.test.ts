import { describe, expect, it } from "vitest";
import {
	adjustmentBlurRadius,
	applyColorMatrixToPixels,
	CANVAS_IMAGE_ADJUSTMENT_PRESETS,
	computeAdjustmentColorMatrix,
	isIdentityAdjustments,
	toSvgColorMatrix,
} from "../image-adjustments.js";
import { CanvasImageAdjustmentsSchema } from "../validators.js";

describe("computeAdjustmentColorMatrix (C-04, FR-100)", () => {
	it("neutral adjustments compile to null (identity)", () => {
		expect(computeAdjustmentColorMatrix({})).toBeNull();
		expect(computeAdjustmentColorMatrix({ blur: 10 })).toBeNull();
		expect(isIdentityAdjustments(undefined)).toBe(true);
		expect(isIdentityAdjustments({})).toBe(true);
		expect(isIdentityAdjustments({ blur: 4 })).toBe(false);
		expect(isIdentityAdjustments({ brightness: 0.2 })).toBe(false);
	});

	it("brightness is a pure intercept; contrast pivots around 0.5", () => {
		const m = computeAdjustmentColorMatrix({ brightness: 0.2 });
		expect(m).not.toBeNull();
		if (!m) return;
		expect(m[0]).toBeCloseTo(1); // slope untouched
		expect(m[3]).toBeCloseTo(0.2); // R intercept
		expect(m[7]).toBeCloseTo(0.2); // G intercept
		expect(m[11]).toBeCloseTo(0.2); // B intercept

		const c = computeAdjustmentColorMatrix({ contrast: 0.5 });
		if (!c) throw new Error("expected matrix");
		expect(c[0]).toBeCloseTo(1.5);
		// mid-gray stays fixed: 0.5·slope + intercept = 0.5
		expect(0.5 * (c[0] ?? 0) + (c[3] ?? 0)).toBeCloseTo(0.5);
	});

	it("temperature shifts R up and B down; tint shifts G down", () => {
		const m = computeAdjustmentColorMatrix({ temperature: 1 });
		if (!m) throw new Error("expected matrix");
		expect((m[3] ?? 0) > (m[7] ?? 0)).toBe(true); // R intercept > G
		expect((m[11] ?? 0) < (m[7] ?? 0)).toBe(true); // B intercept < G
		const t = computeAdjustmentColorMatrix({ tint: 1 });
		if (!t) throw new Error("expected matrix");
		expect((t[7] ?? 0) < (t[3] ?? 0)).toBe(true);
	});

	it("grayscale: 1 produces equal rows (fully desaturated)", () => {
		const m = computeAdjustmentColorMatrix({ grayscale: 1 });
		if (!m) throw new Error("expected matrix");
		expect(m[0]).toBeCloseTo(m[4] ?? 0);
		expect(m[1]).toBeCloseTo(m[5] ?? 0);
		expect(m[2]).toBeCloseTo(m[6] ?? 0);
		// Rec.601 luma row sums to 1.
		expect((m[0] ?? 0) + (m[1] ?? 0) + (m[2] ?? 0)).toBeCloseTo(1);
	});

	it("toSvgColorMatrix appends the identity alpha row (20 values)", () => {
		const m = computeAdjustmentColorMatrix({ sepia: 1 });
		if (!m) throw new Error("expected matrix");
		const svg = toSvgColorMatrix(m);
		expect(svg).toHaveLength(20);
		// Alpha coefficient is 0 in every color row; alpha row is identity.
		expect(svg[3]).toBe(0);
		expect(svg[8]).toBe(0);
		expect(svg[13]).toBe(0);
		expect(svg.slice(15)).toEqual([0, 0, 0, 1, 0]);
		// Offsets land in the 5th slot of each row.
		expect(svg[4]).toBeCloseTo(m[3] ?? Number.NaN);
	});

	it("applyColorMatrixToPixels matches the matrix on a known pixel", () => {
		const m = computeAdjustmentColorMatrix({ brightness: 0.2, contrast: 0.5 });
		if (!m) throw new Error("expected matrix");
		const data = new Uint8ClampedArray([128, 64, 255, 200]);
		applyColorMatrixToPixels(data, m);
		// Diagonal-only matrix: out_c = clamp(255 · (slope·(in_c/255) + intercept_c)).
		const out = (v: number, row: number): number => {
			const raw =
				255 * ((m[row * 4 + row] ?? 0) * (v / 255) + (m[row * 4 + 3] ?? 0));
			return Math.round(Math.min(255, Math.max(0, raw)));
		};
		expect(data[0]).toBe(out(128, 0));
		expect(data[1]).toBe(out(64, 1));
		expect(data[2]).toBe(out(255, 2));
		expect(data[3]).toBe(200); // alpha untouched
	});

	it("presets are plain adjustment values that all validate", () => {
		for (const preset of Object.values(CANVAS_IMAGE_ADJUSTMENT_PRESETS)) {
			expect(CanvasImageAdjustmentsSchema.safeParse(preset).success).toBe(true);
		}
		expect(
			isIdentityAdjustments(CANVAS_IMAGE_ADJUSTMENT_PRESETS.original),
		).toBe(true);
		expect(adjustmentBlurRadius({ blur: 12 })).toBe(12);
	});

	it("schema rejects out-of-range values", () => {
		expect(
			CanvasImageAdjustmentsSchema.safeParse({ brightness: 2 }).success,
		).toBe(false);
		expect(CanvasImageAdjustmentsSchema.safeParse({ blur: 500 }).success).toBe(
			false,
		);
		expect(
			CanvasImageAdjustmentsSchema.safeParse({ grayscale: -0.1 }).success,
		).toBe(false);
	});
});
