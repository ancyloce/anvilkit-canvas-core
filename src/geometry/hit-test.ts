import type { CanvasNode } from "../ir/types.js";
import {
	type AffineMatrix,
	applyMatrix,
	type BoundsExtent,
	invertMatrix,
	multiplyMatrix,
	toAffineMatrix,
} from "./affine.js";

/**
 * Rotation-aware hit-testing for `@anvilkit/canvas-core`.
 *
 * All math is framework-free and operates in world (canvas) coordinates. Unlike
 * the editor's earlier axis-aligned approximation (which ignored
 * rotation/scale), these helpers invert the node's full affine transform, so a
 * rotated node is hit only where it actually is.
 */

/** Axis-aligned bounding box in world coordinates. Alias of geometry's BoundsExtent. */
export type Aabb = BoundsExtent;

interface Point {
	x: number;
	y: number;
}

const IDENTITY: AffineMatrix = [1, 0, 0, 1, 0, 0];

function boxAabb(m: AffineMatrix, width: number, height: number): Aabb {
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
 * World-space axis-aligned bounding box of a node, accounting for its
 * rotation/scale/skew. Pass `parentMatrix` to place a node nested under a
 * transformed ancestor; omit it for top-level (world-space) nodes.
 */
export function nodeWorldAabb(
	node: CanvasNode,
	parentMatrix: AffineMatrix = IDENTITY,
): Aabb {
	const m = multiplyMatrix(parentMatrix, toAffineMatrix(node.transform));
	return boxAabb(m, node.bounds.width, node.bounds.height);
}

/**
 * True when `world` falls inside a node's box, accounting for rotation/scale/
 * skew. A degenerate (zero-area / non-invertible) node contains nothing.
 */
export function pointInNode(
	node: CanvasNode,
	world: Point,
	parentMatrix: AffineMatrix = IDENTITY,
): boolean {
	const m = multiplyMatrix(parentMatrix, toAffineMatrix(node.transform));
	let inv: AffineMatrix;
	try {
		inv = invertMatrix(m);
	} catch {
		return false;
	}
	const [lx, ly] = applyMatrix(inv, world.x, world.y);
	const { width, height } = node.bounds;
	return lx >= 0 && lx <= width && ly >= 0 && ly <= height;
}

export interface HitTestOptions {
	skipLocked?: boolean;
	skipInvisible?: boolean;
}

/**
 * The top-most node whose box contains `world`. Nodes are taken in paint order
 * (later siblings paint on top, matching `page.root.children`), so the last
 * match wins. Returns null when nothing is hit.
 */
export function hitTest(
	nodes: readonly CanvasNode[],
	world: Point,
	opts: HitTestOptions = {},
): CanvasNode | null {
	let hit: CanvasNode | null = null;
	for (const node of nodes) {
		if (opts.skipInvisible && node.visible === false) continue;
		if (opts.skipLocked && node.locked) continue;
		if (pointInNode(node, world)) hit = node;
	}
	return hit;
}

export interface MarqueeHitsOptions {
	/** Require the node to be fully inside the marquee (default: any overlap). */
	contained?: boolean;
	skipLocked?: boolean;
	skipInvisible?: boolean;
}

function aabbIntersect(a: Aabb, b: Aabb): boolean {
	return !(
		a.maxX < b.minX ||
		b.maxX < a.minX ||
		a.maxY < b.minY ||
		b.maxY < a.minY
	);
}

function aabbContains(outer: Aabb, inner: Aabb): boolean {
	return (
		inner.minX >= outer.minX &&
		inner.maxX <= outer.maxX &&
		inner.minY >= outer.minY &&
		inner.maxY <= outer.maxY
	);
}

/**
 * Nodes selected by a marquee rectangle (in world coordinates). Uses each
 * node's rotation-aware world AABB; `contained` switches from any-overlap to
 * fully-enclosed. Returns matches in input order.
 */
export function marqueeHits(
	nodes: readonly CanvasNode[],
	marquee: Aabb,
	opts: MarqueeHitsOptions = {},
): CanvasNode[] {
	const hits: CanvasNode[] = [];
	for (const node of nodes) {
		if (opts.skipInvisible && node.visible === false) continue;
		if (opts.skipLocked && node.locked) continue;
		const box = nodeWorldAabb(node);
		const match = opts.contained
			? aabbContains(marquee, box)
			: aabbIntersect(marquee, box);
		if (match) hits.push(node);
	}
	return hits;
}
