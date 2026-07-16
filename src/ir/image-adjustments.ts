import type { CanvasImageAdjustments } from "./types.js";

/**
 * Non-destructive image adjustments (C-04, PRD 0012 FR-100/101).
 *
 * The ONE math source for every renderer: adjustments compile to a single
 * 5x4 color matrix (the SVG `feColorMatrix type="matrix"` layout) plus a
 * blur radius. The SVG serializer emits the matrix verbatim; the editor's
 * Konva filter applies the SAME matrix per pixel via
 * {@link applyColorMatrixToPixels} — so the live canvas and exports cannot
 * disagree on color math. The source asset is never modified.
 *
 * Value ranges (all optional, absent = neutral):
 * - `brightness`, `contrast`, `saturation`, `exposure`, `temperature`,
 *   `tint`: -1..1
 * - `grayscale`, `sepia`: 0..1
 * - `blur`: 0..100, in page units (SVG stdDeviation ≈ blur / 2, matching the
 *   shadow convention)
 *
 * Pipeline order (fixed): exposure/brightness/contrast/temperature/tint
 * (per-channel linear) → saturation/grayscale → sepia → blur.
 */

/** A 3x4 color transform in 0..1 space: out_c = row_c · [r g b 1]. */
type Mat3x4 = readonly [
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
	number,
];

/** Compose two 3x4 transforms: result applies `first`, then `second`. */
function compose(second: Mat3x4, first: Mat3x4): Mat3x4 {
	const out: number[] = [];
	for (let row = 0; row < 3; row += 1) {
		const s0 = second[row * 4] ?? 0;
		const s1 = second[row * 4 + 1] ?? 0;
		const s2 = second[row * 4 + 2] ?? 0;
		const s3 = second[row * 4 + 3] ?? 0;
		for (let col = 0; col < 3; col += 1) {
			out.push(
				s0 * (first[col] ?? 0) +
					s1 * (first[4 + col] ?? 0) +
					s2 * (first[8 + col] ?? 0),
			);
		}
		out.push(s0 * first[3] + s1 * first[7] + s2 * first[11] + s3);
	}
	return out as unknown as Mat3x4;
}

/** Rec. 601 luma weights — the same ones SVG's `saturate` matrix uses. */
const LUMA_R = 0.213;
const LUMA_G = 0.715;
const LUMA_B = 0.072;

function saturateMatrix(s: number): Mat3x4 {
	const inv = 1 - s;
	return [
		LUMA_R * inv + s,
		LUMA_G * inv,
		LUMA_B * inv,
		0,
		LUMA_R * inv,
		LUMA_G * inv + s,
		LUMA_B * inv,
		0,
		LUMA_R * inv,
		LUMA_G * inv,
		LUMA_B * inv + s,
		0,
	];
}

/** The standard SVG/CSS sepia matrix, interpolated toward identity by `a`. */
function sepiaMatrix(a: number): Mat3x4 {
	const l = 1 - a;
	return [
		0.393 + 0.607 * l,
		0.769 - 0.769 * l,
		0.189 - 0.189 * l,
		0,
		0.349 - 0.349 * l,
		0.686 + 0.314 * l,
		0.168 - 0.168 * l,
		0,
		0.272 - 0.272 * l,
		0.534 - 0.534 * l,
		0.131 + 0.869 * l,
		0,
	];
}

/** Strength of the temperature/tint channel shifts at |value| = 1. */
const CHANNEL_SHIFT = 0.15;

function clamp01(v: number): number {
	return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Compile adjustments into the combined 3x4 color transform, or `null` when
 * every color adjustment is neutral (blur alone never needs a matrix).
 */
export function computeAdjustmentColorMatrix(
	adjustments: CanvasImageAdjustments,
): number[] | null {
	const {
		brightness = 0,
		contrast = 0,
		saturation = 0,
		exposure = 0,
		temperature = 0,
		tint = 0,
		grayscale = 0,
		sepia = 0,
	} = adjustments;
	if (
		brightness === 0 &&
		contrast === 0 &&
		saturation === 0 &&
		exposure === 0 &&
		temperature === 0 &&
		tint === 0 &&
		grayscale === 0 &&
		sepia === 0
	) {
		return null;
	}
	// v' = ((v · 2^e + b + shift_c) − 0.5) · (1 + c) + 0.5
	const slope = 2 ** exposure * (1 + contrast);
	const interceptFor = (shift: number): number =>
		(brightness + shift - 0.5) * (1 + contrast) + 0.5;
	const linear: Mat3x4 = [
		slope,
		0,
		0,
		interceptFor(CHANNEL_SHIFT * temperature),
		0,
		slope,
		0,
		interceptFor(-CHANNEL_SHIFT * tint),
		0,
		0,
		slope,
		interceptFor(-CHANNEL_SHIFT * temperature),
	];
	let m = linear;
	const sat = Math.max(0, 1 + saturation - clamp01(grayscale));
	if (sat !== 1) m = compose(saturateMatrix(sat), m);
	if (sepia > 0) m = compose(sepiaMatrix(clamp01(sepia)), m);
	return [...m];
}

/**
 * The 20-value `feColorMatrix type="matrix"` form: each RGBA output row is
 * `[r g b a offset]`. Our 3x4 rows are `[r g b offset]` with no alpha
 * dependence, so an alpha coefficient of 0 is inserted before each offset,
 * and the alpha row is identity.
 */
export function toSvgColorMatrix(matrix: readonly number[]): number[] {
	const out: number[] = [];
	for (let row = 0; row < 3; row += 1) {
		out.push(
			matrix[row * 4] ?? 0,
			matrix[row * 4 + 1] ?? 0,
			matrix[row * 4 + 2] ?? 0,
			0,
			matrix[row * 4 + 3] ?? 0,
		);
	}
	out.push(0, 0, 0, 1, 0);
	return out;
}

/** Blur radius contributed by adjustments (0 when unset). */
export function adjustmentBlurRadius(
	adjustments: CanvasImageAdjustments,
): number {
	return Math.max(0, adjustments.blur ?? 0);
}

/** True when the adjustment set changes nothing (safe to skip filtering). */
export function isIdentityAdjustments(
	adjustments: CanvasImageAdjustments | undefined,
): boolean {
	if (!adjustments) return true;
	return (
		computeAdjustmentColorMatrix(adjustments) === null &&
		adjustmentBlurRadius(adjustments) === 0
	);
}

/**
 * Apply a 3x4 color matrix (0..1 space) to interleaved RGBA pixel bytes in
 * place — the editor's Konva filter delegates here so the canvas applies the
 * exact matrix the SVG export embeds. Alpha is untouched.
 */
export function applyColorMatrixToPixels(
	data: Uint8ClampedArray,
	matrix: readonly number[],
): void {
	const m = matrix;
	for (let i = 0; i < data.length; i += 4) {
		const r = (data[i] ?? 0) / 255;
		const g = (data[i + 1] ?? 0) / 255;
		const b = (data[i + 2] ?? 0) / 255;
		data[i] =
			255 * ((m[0] ?? 1) * r + (m[1] ?? 0) * g + (m[2] ?? 0) * b + (m[3] ?? 0));
		data[i + 1] =
			255 * ((m[4] ?? 0) * r + (m[5] ?? 1) * g + (m[6] ?? 0) * b + (m[7] ?? 0));
		data[i + 2] =
			255 *
			((m[8] ?? 0) * r + (m[9] ?? 0) * g + (m[10] ?? 1) * b + (m[11] ?? 0));
	}
}

export type CanvasImageAdjustmentPresetId =
	| "original"
	| "warm"
	| "cool"
	| "mono"
	| "vintage"
	| "high-contrast";

/**
 * FR-101 presets — plain adjustment values, never a separate model. Applying
 * one REPLACES the node's adjustments with these values.
 */
export const CANVAS_IMAGE_ADJUSTMENT_PRESETS: Record<
	CanvasImageAdjustmentPresetId,
	CanvasImageAdjustments
> = {
	original: {},
	warm: { temperature: 0.35, saturation: 0.1 },
	cool: { temperature: -0.35, saturation: 0.05 },
	mono: { grayscale: 1 },
	vintage: { sepia: 0.45, contrast: -0.1, brightness: 0.05 },
	"high-contrast": { contrast: 0.35, saturation: 0.1 },
};
