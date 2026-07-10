import { type AffineMatrix, applyMatrix, invertMatrix } from "./affine.js";

/**
 * Viewport pan/zoom math for `@anvilkit/canvas-core`.
 *
 * Mirrors the editor's viewport-store fields and the `<CanvasStage>` Konva
 * transform (`scaleX = scaleY = zoom`, `x = panX`, `y = panY`). Because the
 * Stage is the Konva root, this matrix equals its `getAbsoluteTransform()`, so
 * `screenToWorld` is a framework-free replacement for inverting that transform —
 * usable in headless tests and off-stage consumers.
 */

/** The pan/zoom state of a canvas viewport. */
export interface ViewportDescriptor {
	zoom: number;
	panX: number;
	panY: number;
}

interface Point {
	x: number;
	y: number;
}

/**
 * Affine matrix mapping world (canvas) coordinates to screen (stage-pixel)
 * coordinates: `screen = world * zoom + pan`.
 */
export function viewportMatrix(v: ViewportDescriptor): AffineMatrix {
	return [v.zoom, 0, 0, v.zoom, v.panX, v.panY];
}

/** Map a world (canvas) point to screen (stage-pixel) coordinates. */
export function worldToScreen(v: ViewportDescriptor, p: Point): Point {
	const [x, y] = applyMatrix(viewportMatrix(v), p.x, p.y);
	return { x, y };
}

/**
 * Map a screen (stage-pixel) point back to world (canvas) coordinates. Throws
 * if `zoom` is 0 (a degenerate, non-invertible viewport).
 */
export function screenToWorld(v: ViewportDescriptor, p: Point): Point {
	const [x, y] = applyMatrix(invertMatrix(viewportMatrix(v)), p.x, p.y);
	return { x, y };
}
