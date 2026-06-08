import type { CanvasTransform } from "./types.js";

/**
 * Affine-transform geometry for `@anvilkit/canvas-core`.
 *
 * Shared by the SVG serializer (transform attribute) and the command runtime
 * (group bounding boxes) so the matrix math — which must replicate Konva's
 * `Node.getTransform` order exactly — lives in one place.
 */

const DEG_TO_RAD = Math.PI / 180;

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
