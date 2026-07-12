import type { CanvasBounds } from "../ir/types.js";

/**
 * Pure vertex geometry for `polygon` and `star` nodes (FR-014).
 *
 * Shared by the SVG serializer (`emitPolygon`/`emitStar`) and available to a
 * future per-kind hit test — today `pointInNode` uses a uniform bounds test
 * for every kind (`hit-test.ts`), so nothing here is wired into hit-testing
 * yet, but the vertex list is the natural input for a precise point-in-polygon
 * test later.
 */

export interface PolygonVertex {
	x: number;
	y: number;
}

/** Angle (radians) of the first vertex: straight up, 12 o'clock. */
const START_ANGLE = -Math.PI / 2;

/**
 * Vertices of a regular polygon inscribed in `bounds`, one per `sides`,
 * evenly spaced starting at the top and going clockwise (SVG's y-down
 * convention). The ellipse `bounds` inscribes need not be a circle — a
 * non-square box stretches the polygon along the wider axis.
 */
export function computePolygonVertices(
	bounds: CanvasBounds,
	sides: number,
): PolygonVertex[] {
	const cx = bounds.width / 2;
	const cy = bounds.height / 2;
	const rx = bounds.width / 2;
	const ry = bounds.height / 2;
	const angleStep = (Math.PI * 2) / sides;
	const vertices: PolygonVertex[] = [];
	for (let i = 0; i < sides; i++) {
		const angle = START_ANGLE + i * angleStep;
		vertices.push({
			x: cx + rx * Math.cos(angle),
			y: cy + ry * Math.sin(angle),
		});
	}
	return vertices;
}

/**
 * Vertices of a star inscribed in `bounds`: `points` outer tips alternating
 * with `points` inner vertices at `innerRadiusRatio` of the outer radius
 * (0 collapses the inner ring to the center; 1 makes every vertex outer,
 * tracing a regular `points`-gon whose extra vertices sit exactly on its
 * edges' midpoints).
 */
export function computeStarVertices(
	bounds: CanvasBounds,
	points: number,
	innerRadiusRatio: number,
): PolygonVertex[] {
	const cx = bounds.width / 2;
	const cy = bounds.height / 2;
	const outerRx = bounds.width / 2;
	const outerRy = bounds.height / 2;
	const innerRx = outerRx * innerRadiusRatio;
	const innerRy = outerRy * innerRadiusRatio;
	const vertexCount = points * 2;
	const angleStep = (Math.PI * 2) / vertexCount;
	const vertices: PolygonVertex[] = [];
	for (let i = 0; i < vertexCount; i++) {
		const angle = START_ANGLE + i * angleStep;
		const isOuter = i % 2 === 0;
		const rx = isOuter ? outerRx : innerRx;
		const ry = isOuter ? outerRy : innerRy;
		vertices.push({
			x: cx + rx * Math.cos(angle),
			y: cy + ry * Math.sin(angle),
		});
	}
	return vertices;
}
