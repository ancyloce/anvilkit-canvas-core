import type { CanvasTransform } from "../ir/types.js";

/**
 * Affine-transform geometry for `@anvilkit/canvas-core`.
 *
 * Shared by the SVG serializer (transform attribute) and the command runtime
 * (group bounding boxes) so the matrix math — which must replicate Konva's
 * `Node.getTransform` order exactly — lives in one place.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
/** Determinant magnitude below which a matrix is treated as singular. */
const SINGULAR_EPSILON = 1e-12;

/** SVG `matrix(a b c d e f)` tuple: point (x,y) → (a·x + c·y + e, b·x + d·y + f). */
export type AffineMatrix = [number, number, number, number, number, number];

function matrixTranslate(m: AffineMatrix, x: number, y: number): void {
	m[4] += m[0] * x + m[2] * y;
	m[5] += m[1] * x + m[3] * y;
}

function matrixRotate(m: AffineMatrix, rad: number): void {
	const c = Math.cos(rad);
	const s = Math.sin(rad);
	const m11 = m[0] * c + m[2] * s;
	const m12 = m[1] * c + m[3] * s;
	const m21 = m[0] * -s + m[2] * c;
	const m22 = m[1] * -s + m[3] * c;
	m[0] = m11;
	m[1] = m12;
	m[2] = m21;
	m[3] = m22;
}

function matrixScale(m: AffineMatrix, sx: number, sy: number): void {
	m[0] *= sx;
	m[1] *= sx;
	m[2] *= sy;
	m[3] *= sy;
}

function matrixSkew(m: AffineMatrix, kx: number, ky: number): void {
	const m11 = m[0] + m[2] * ky;
	const m12 = m[1] + m[3] * ky;
	const m21 = m[2] + m[0] * kx;
	const m22 = m[3] + m[1] * kx;
	m[0] = m11;
	m[1] = m12;
	m[2] = m21;
	m[3] = m22;
}

/**
 * Compose a transform into an affine matrix, replicating Konva's
 * `Node.getTransform` order exactly: translate → rotate → skew → scale.
 * (CanvasIR has no `offset`, so the trailing offset translate is always 0.)
 */
export function toAffineMatrix(t: CanvasTransform): AffineMatrix {
	const m: AffineMatrix = [1, 0, 0, 1, 0, 0];
	if (t.x !== 0 || t.y !== 0) matrixTranslate(m, t.x, t.y);
	if (t.rotation !== 0) matrixRotate(m, t.rotation * DEG_TO_RAD);
	const skewX = t.skewX ?? 0;
	const skewY = t.skewY ?? 0;
	if (skewX !== 0 || skewY !== 0) matrixSkew(m, skewX, skewY);
	if (t.scaleX !== 1 || t.scaleY !== 1) matrixScale(m, t.scaleX, t.scaleY);
	return m;
}

/** Apply an affine matrix to a point. */
export function applyMatrix(
	m: AffineMatrix,
	x: number,
	y: number,
): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export interface BoundsExtent {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Axis-aligned bounding box, in the parent coordinate space, of a
 * `width`×`height` box anchored at the local origin after applying `transform`.
 * Accounts for rotation/scale/skew, unlike a naive `x + width` extent.
 */
export function transformedBoundsExtent(
	transform: CanvasTransform,
	width: number,
	height: number,
): BoundsExtent {
	const m = toAffineMatrix(transform);
	const corners: Array<[number, number]> = [
		applyMatrix(m, 0, 0),
		applyMatrix(m, width, 0),
		applyMatrix(m, width, height),
		applyMatrix(m, 0, height),
	];
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const [x, y] of corners) {
		if (x < minX) minX = x;
		if (y < minY) minY = y;
		if (x > maxX) maxX = x;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

/**
 * Multiply two affine matrices. The result applies `m2` first, then `m1` — i.e.
 * `applyMatrix(multiplyMatrix(m1, m2), p) === applyMatrix(m1, applyMatrix(m2, p))`.
 * Use `multiplyMatrix(parentMatrix, childMatrix)` to compose a child transform
 * into its parent's coordinate space.
 */
export function multiplyMatrix(
	m1: AffineMatrix,
	m2: AffineMatrix,
): AffineMatrix {
	const [a1, b1, c1, d1, e1, f1] = m1;
	const [a2, b2, c2, d2, e2, f2] = m2;
	return [
		a1 * a2 + c1 * b2,
		b1 * a2 + d1 * b2,
		a1 * c2 + c1 * d2,
		b1 * c2 + d1 * d2,
		a1 * e2 + c1 * f2 + e1,
		b1 * e2 + d1 * f2 + f1,
	];
}

/**
 * Invert an affine matrix. Throws if the matrix is singular (its determinant is
 * zero or non-finite), e.g. a zero-scale transform that collapses a dimension.
 */
export function invertMatrix(m: AffineMatrix): AffineMatrix {
	const [a, b, c, d, e, f] = m;
	const det = a * d - b * c;
	if (!Number.isFinite(det) || Math.abs(det) < SINGULAR_EPSILON) {
		throw new Error(
			"invertMatrix: matrix is singular (zero or non-finite determinant)",
		);
	}
	const inv = 1 / det;
	return [
		d * inv,
		-b * inv,
		-c * inv,
		a * inv,
		(c * f - d * e) * inv,
		(b * e - a * f) * inv,
	];
}

/**
 * Components recovered from an affine matrix, compatible with `CanvasTransform`.
 * The shear is reported entirely as `skewX` (the canonical 2D affine
 * decomposition folds any `skewY` into rotation/scale/`skewX`), so `skewY` is
 * always 0 and omitted. `rotation` is in degrees, in the range (-180, 180].
 */
export interface DecomposedTransform {
	x: number;
	y: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	skewX: number;
}

/**
 * Decompose an affine matrix back into translate/rotate/skew/scale components,
 * the exact inverse of {@link toAffineMatrix} (and of Konva's
 * `Transform.decompose`). For a transform with no `skewY`,
 * `decomposeMatrix(toAffineMatrix(t))` round-trips `t`; for the general case the
 * recomposed matrix `toAffineMatrix(decomposeMatrix(m))` equals `m`.
 */
export function decomposeMatrix(m: AffineMatrix): DecomposedTransform {
	const [a, b, c, d, e, f] = m;
	const delta = a * d - b * c;
	const result: DecomposedTransform = {
		x: e,
		y: f,
		rotation: 0,
		scaleX: 0,
		scaleY: 0,
		skewX: 0,
	};
	if (a !== 0 || b !== 0) {
		const r = Math.sqrt(a * a + b * b);
		result.rotation =
			(b > 0 ? Math.acos(a / r) : -Math.acos(a / r)) * RAD_TO_DEG;
		result.scaleX = r;
		result.scaleY = delta / r;
		// A singular matrix (delta === 0, e.g. a collapsed scaleY:0 transform)
		// would otherwise divide by zero here — NaN, not the finite 0 the
		// transform schema requires (C-10).
		result.skewX = delta !== 0 ? (a * c + b * d) / delta : 0;
	} else if (c !== 0 || d !== 0) {
		const s = Math.sqrt(c * c + d * d);
		result.rotation =
			(Math.PI / 2 - (d > 0 ? Math.acos(-c / s) : -Math.acos(c / s))) *
			RAD_TO_DEG;
		result.scaleX = delta / s;
		result.scaleY = s;
	}
	// Normalize -0 → +0 so callers comparing with Object.is/toEqual don't trip
	// (matches the convention in computeSnap).
	result.rotation = result.rotation || 0;
	return result;
}
