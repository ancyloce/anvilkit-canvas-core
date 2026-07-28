import type { CanvasBounds, CanvasNode } from "../ir/types.js";
import {
	type AffineMatrix,
	applyMatrix,
	type BoundsExtent,
	invertMatrix,
	matrixBoundsExtent,
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

/** The shared corner-loop, kept under this module's local name. */
const boxAabb = matrixBoundsExtent;

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
	return pointInBox(m, node.bounds.width, node.bounds.height, world);
}

/** Shared inverse-transform containment check for the raw and resolved paths. */
function pointInBox(
	m: AffineMatrix,
	width: number,
	height: number,
	world: Point,
): boolean {
	let inv: AffineMatrix;
	try {
		inv = invertMatrix(m);
	} catch {
		return false;
	}
	const [lx, ly] = applyMatrix(inv, world.x, world.y);
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

/**
 * Minimal structural view of a resolved-layout record, for the resolved
 * variants below.
 *
 * `geometry/` is rank 2 and `layout/` is rank 4, so the real
 * `CanvasResolvedNodeRecord` cannot be imported here; it is structurally
 * assignable to this shape instead. The variants consume the WORLD transform
 * and AABB the resolver already computed — they compose no ancestor chain and
 * re-derive no geometry, which is the whole point of the resolved tree.
 */
export interface ResolvedHitTarget {
	/** The source node — style/skip flags are read from here, geometry never is. */
	readonly node: CanvasNode;
	readonly geometry: {
		/** `parentWorld × local`, as produced by the layout resolver. */
		readonly worldTransform: AffineMatrix;
		/** Resolved local box size. */
		readonly bounds: CanvasBounds;
		/** Resolved world-space AABB. */
		readonly worldAabb: Aabb;
	};
}

/**
 * Resolved-record variant of {@link pointInNode}: containment against the
 * record's world transform. Takes no parent matrix — `worldTransform` is
 * already fully composed.
 */
export function pointInResolvedNode(
	target: ResolvedHitTarget,
	world: Point,
): boolean {
	const { worldTransform, bounds } = target.geometry;
	return pointInBox(worldTransform, bounds.width, bounds.height, world);
}

/**
 * Resolved-record variant of {@link hitTest}: same paint-order semantics (last
 * match wins) and the same skip flags, read from each record's source node.
 */
export function hitTestResolved<T extends ResolvedHitTarget>(
	targets: readonly T[],
	world: Point,
	opts: HitTestOptions = {},
): T | null {
	let hit: T | null = null;
	for (const target of targets) {
		if (opts.skipInvisible && target.node.visible === false) continue;
		if (opts.skipLocked && target.node.locked) continue;
		if (pointInResolvedNode(target, world)) hit = target;
	}
	return hit;
}

/**
 * Resolved-record variant of {@link marqueeHits}: reads the resolver's world
 * AABB instead of recomputing one, so nested/transformed ancestors are
 * accounted for by construction. Returns matches in input order.
 */
export function marqueeHitsResolved<T extends ResolvedHitTarget>(
	targets: readonly T[],
	marquee: Aabb,
	opts: MarqueeHitsOptions = {},
): T[] {
	const hits: T[] = [];
	for (const target of targets) {
		if (opts.skipInvisible && target.node.visible === false) continue;
		if (opts.skipLocked && target.node.locked) continue;
		const box = target.geometry.worldAabb;
		const match = opts.contained
			? aabbContains(marquee, box)
			: aabbIntersect(marquee, box);
		if (match) hits.push(target);
	}
	return hits;
}
