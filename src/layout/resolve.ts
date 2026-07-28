import {
	type AffineMatrix,
	type BoundsExtent,
	matrixBoundsExtent,
	multiplyMatrix,
	toAffineMatrix,
	transformedBoundsExtent,
} from "../geometry/affine.js";
import { fingerprint64 } from "../hash.js";
import type {
	CanvasBounds,
	CanvasFrameNode,
	CanvasIR,
	CanvasLayoutDirection,
	CanvasLayoutSizing,
	CanvasNode,
	CanvasRichTextNode,
	CanvasTransform,
} from "../ir/types.js";
import { MAX_RETAINED_DIAGNOSTICS, MAX_TREE_DEPTH } from "../limits.js";
import { type AxisAdapter, axisFor } from "./axis.js";
import {
	advanceCacheState,
	createCacheState,
	type LayoutCacheState,
	reuseRecord,
	subtreeSignature,
} from "./cache.js";
import { buildSizingGraph, type SizingGraph } from "./dependency-graph.js";
import {
	createMeasurementContext,
	type LayoutMeasurementContext,
	measureIntrinsicSize,
} from "./measure.js";
import type {
	CanvasLayoutResolveOptions,
	CanvasResolvedDocument,
	CanvasResolvedNodeId,
	CanvasResolvedNodeRecord,
} from "./types.js";
import { toResolvedNodeId } from "./types.js";
import {
	buildDocumentOrder,
	type CanvasLayoutIssue,
	createLayoutIssue,
	orderLayoutIssues,
} from "./validate.js";

/**
 * @file The deterministic Auto Layout solver (TD §7, T-M2-05).
 *
 * The **only** layout algorithm in the product. Every consumer — the editor
 * renderer, hit-testing, snapping, the a11y tree, SVG, raster and PDF — reads
 * the tree this function returns; none of them may compute geometry itself.
 * That is what makes editor/export parity (AC-009) a property of the design
 * rather than something to be re-tested per consumer.
 *
 * Pure by construction: no clock, no RNG, no DOM, no React, no Konva. The one
 * host-provided input is the synchronous, pure measurement port, and a missing
 * or failing measurer degrades to a diagnostic rather than a throw.
 *
 * ### Three rules that are easy to get subtly wrong
 *
 * **All arithmetic is footprint-space (§7.7).** Every size read or written in
 * the sizing phases is a *transformed* extent, never a raw `bounds` value.
 * `bounds` is `{width, height}` while a node's visible extent is `bounds` under
 * `scaleX`/`scaleY`/`skew`/`rotation`. Mixing the two is not merely imprecise,
 * it is non-convergent: a Fill child with `scaleX: 2` handed `fillSize` would
 * occupy `fillSize × 2` and overflow, and a Hug parent would under-count its
 * own children by the same factor.
 *
 * **`gapTotal` is never clamped (§7.3).** Only `fillSize` clamps to zero. A
 * container too small for its gaps still separates its children by the
 * authored gap and overflows — collapsing them would silently break the one
 * spacing guarantee the container exists to provide. Overflow is visible and
 * is reported by `layout-insufficient-space`.
 *
 * **Hidden children participate (§7.2).** `visible: false` is a paint property.
 * Excluding hidden children would make toggling an eye icon reflow the
 * template, and would make the resolved tree disagree with the layer tree
 * about child order.
 */

/** Quantisation quantum: 1e-4 local units, expressed as its reciprocal. */
const QUANTUM_RECIPROCAL = 10_000;

/**
 * Tolerance for internal equality ("is the remaining space zero?").
 *
 * Deliberately the same magnitude as the quantum: comparing with exact `===`
 * below the granularity we are about to round to would make the solver branch
 * on differences it is contractually unable to represent.
 */
const EPSILON = 1e-4;

/** Determinant magnitude below which the bounds solve is treated as degenerate. */
const SINGULAR_EPSILON = 1e-9;

/**
 * Round half away from zero to a 1e-4 quantum — the **single** rounding point
 * in the whole solver (§6.1).
 *
 * Two steps of the algorithm are inherently lossy: `remaining / fillCount` and
 * the `/2` of Center alignment. Rounding at intermediate steps, or not at all,
 * lets one document produce last-bit-different geometry in a browser and in an
 * export worker — which breaks export parity (AC-009) without breaking any
 * test that compares numbers approximately.
 *
 * `Math.round` rounds half toward +∞, so the negative branch is mirrored
 * explicitly. Division by 10,000 (rather than multiplication by 1e-4) is what
 * makes the result the canonical double for that decimal.
 */
export function quantise(value: number): number {
	if (!Number.isFinite(value)) return 0;
	const scaled = value * QUANTUM_RECIPROCAL;
	const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
	// `-0` is `=== 0` but serializes as "-0"; normalising keeps output byte-stable.
	return rounded === 0 ? 0 : rounded / QUANTUM_RECIPROCAL;
}

function quantiseBounds(bounds: CanvasBounds): CanvasBounds {
	return {
		width: Math.max(0, quantise(bounds.width)),
		height: Math.max(0, quantise(bounds.height)),
	};
}

function quantiseTransform(transform: CanvasTransform): CanvasTransform {
	return {
		...transform,
		x: quantise(transform.x),
		y: quantise(transform.y),
	};
}

/** The node's matrix with translation removed — the pure shape of its footprint. */
function shapeMatrix(transform: CanvasTransform): AffineMatrix {
	return toAffineMatrix({ ...transform, x: 0, y: 0 });
}

/**
 * Extent of a transformed box, as a linear function of its dimensions.
 *
 * For a box with corners `(0,0) (w,0) (w,h) (0,h)` under `matrix(a b c d e f)`,
 * the x-coordinates are `{0, a·w, a·w + c·h, c·h}`, so the axis-aligned extent
 * is exactly `|a|·w + |c|·h`; likewise `|b|·w + |d|·h` on y. This exactness is
 * what lets the solver *invert* the relationship below instead of iterating.
 */
function extentCoefficients(m: AffineMatrix): {
	ax: number;
	cx: number;
	by: number;
	dy: number;
} {
	return {
		ax: Math.abs(m[0]),
		cx: Math.abs(m[2]),
		by: Math.abs(m[1]),
		dy: Math.abs(m[3]),
	};
}

/**
 * Find the `bounds` whose transformed footprint hits the requested extents.
 *
 * With no rotation or skew this is the identity most of the time — the
 * interesting case is a rotated child, where changing `width` moves *both*
 * footprint extents, so the two axes cannot be solved independently. The
 * relationship is linear and exact (see {@link extentCoefficients}), so a 2×2
 * solve gives the answer in closed form; no fixpoint iteration is involved,
 * which is what keeps the pass O(nodes).
 *
 * A `undefined` target means "layout does not control this axis" — that
 * dimension is held at its current value and only the other is solved for.
 *
 * ### Two boundaries, stated rather than hidden
 *
 * **Degenerate:** when the coefficient linking a dimension to its target
 * extent is ~0 — a child rotated exactly 90° with only *one* axis
 * layout-controlled — no width can produce the requested extent, because at
 * that orientation the x-extent is a function of height alone. The current
 * dimension is kept. (With *both* axes controlled the same 90° case is not
 * degenerate at all: the solve correctly swaps width and height.)
 *
 * **Unreachable:** with both axes controlled, a rotation constrains the
 * *ratio* of the two extents, so not every pair is achievable — a 30°-rotated
 * box cannot have a 200×100 footprint at any non-negative size, and the solve
 * returns a negative height. Clamping to zero keeps "no negative bound"
 * absolute and lets the content overflow, which is the same graceful
 * degradation the solver applies everywhere else.
 *
 * Neither case emits a diagnostic. TD §14's code union is frozen at 11 members
 * and has none for "this orientation cannot satisfy this request"; inventing a
 * twelfth would create exactly the parallel taxonomy the design forbids. The
 * footprint invariant (TS-08) therefore holds **wherever the allocation is
 * reachable**, which is every unrotated case and every rotated case whose
 * target ratio the orientation admits.
 */
function solveBounds(
	m: AffineMatrix,
	targetX: number | undefined,
	targetY: number | undefined,
	current: CanvasBounds,
): CanvasBounds {
	if (targetX === undefined && targetY === undefined) return current;
	const { ax, cx, by, dy } = extentCoefficients(m);

	if (targetX !== undefined && targetY !== undefined) {
		const det = ax * dy - cx * by;
		if (Math.abs(det) > SINGULAR_EPSILON) {
			const width = (targetX * dy - targetY * cx) / det;
			const height = (targetY * ax - targetX * by) / det;
			// A negative solution means the requested extents are unreachable for
			// this orientation (they describe a box the transform cannot produce);
			// clamping to 0 keeps the invariant "no negative bound" absolute.
			return { width: Math.max(0, width), height: Math.max(0, height) };
		}
		// Singular: fall back to independent per-axis solves below.
	}

	let { width, height } = current;
	if (targetX !== undefined && ax > SINGULAR_EPSILON) {
		width = (targetX - cx * height) / ax;
	}
	if (targetY !== undefined && dy > SINGULAR_EPSILON) {
		height = (targetY - by * width) / dy;
	}
	return { width: Math.max(0, width), height: Math.max(0, height) };
}

/** A node placed in its parent's coordinate space, with its subtree resolved. */
interface PlacedNode {
	readonly source: CanvasNode;
	readonly bounds: CanvasBounds;
	readonly transform: CanvasTransform;
	/** Footprint at zero translation — the shape the parent allocated space for. */
	readonly shape: BoundsExtent;
	readonly children: readonly PlacedNode[];
}

/** Space the parent has decided this node occupies, in footprint extents. */
interface Allocation {
	width?: number;
	height?: number;
}

interface ResolveState {
	readonly graph: SizingGraph;
	readonly measurement: LayoutMeasurementContext;
	readonly issues: CanvasLayoutIssue[];
	/** How many times each node has been sized this pass — the §7.8 bound of 2. */
	readonly sizings: Map<string, number>;
	/**
	 * The most recent result per node, so a would-be third sizing can return the
	 * second one instead of recomputing.
	 *
	 * This is what makes §7.8's bound real rather than advisory. Without it,
	 * nested Fill containers each re-resolve their whole subtree, and work grows
	 * as 2^depth — at the permitted depth of 10 that is a thousandfold blow-up
	 * on a document that looks entirely ordinary.
	 */
	readonly lastResult: Map<string, PlacedNode>;
	/** Containers that have already reported insufficient space, per axis. */
	readonly reportedOverflow: Set<string>;
	/** Signatures and the prior resolution, for the warm path. */
	readonly cache: LayoutCacheState;
	/** Subtrees placed THIS pass, carried forward as the next pass's warm state. */
	readonly nextPlaced: Map<string, unknown>;
	/** Subtrees reused from the prior resolution this pass — for tests and telemetry. */
	readonly reusedSubtrees: Set<string>;
}

function isAutoLayoutFrame(node: CanvasNode): node is CanvasFrameNode & {
	autoLayout: NonNullable<CanvasFrameNode["autoLayout"]>;
} {
	return node.type === "frame" && node.autoLayout !== undefined;
}

function childrenOf(node: CanvasNode): readonly CanvasNode[] {
	return (node as { children?: readonly CanvasNode[] }).children ?? [];
}

/**
 * The sizing mode actually in force for one axis of one node.
 *
 * `layoutItem` is authoritative on the axis it controls (§7.2). Where it says
 * nothing, a kind-specific size field still applies — a `rich-text` node with
 * `sizing: "auto-width"` hugs its inline axis even with no `layoutItem`, which
 * is what makes Auto Layout additive to a node that already sized itself.
 *
 * A direct contradiction (`sizing: "auto-width"` with `widthSizing: "fixed"`)
 * resolves silently to `layoutItem` and emits nothing: the combination is
 * expected mid-conversion, and flagging it would produce noise on every wrap.
 * The kind-specific fields are **never rewritten**, so removing Auto Layout
 * restores the node's standalone behaviour with no reconstruction step.
 */
function effectiveSizing(
	node: CanvasNode,
	field: "widthSizing" | "heightSizing",
	graph: SizingGraph,
): CanvasLayoutSizing {
	const resolved = graph.effectiveSizing(node, field);
	if (node.layoutItem?.[field] !== undefined || graph.wasDemoted(node, field)) {
		return resolved;
	}
	if (node.type === "rich-text") {
		const rich = node as CanvasRichTextNode;
		if (field === "widthSizing" && rich.sizing === "auto-width") return "hug";
		if (field === "heightSizing" && rich.overflow === "auto-height")
			return "hug";
	}
	return resolved;
}

function isAbsolute(node: CanvasNode): boolean {
	return node.layoutItem?.positioning === "absolute";
}

/**
 * Resolve one node and its subtree.
 *
 * `allocation` carries footprint extents the parent has already decided. An
 * absent entry means this node sizes that axis itself (Fixed or Hug).
 */
function resolveNode(
	node: CanvasNode,
	allocation: Allocation,
	depth: number,
	state: ResolveState,
): PlacedNode {
	// Warm path. A subtree whose signature and allocation both match the
	// previous resolution cannot have moved, so it is returned wholesale
	// without recursing — this is the compute saving the ≤16 ms warm target
	// needs, and it is what `reuseRecord` then turns into reference identity.
	const cacheKey = `${node.id} ${subtreeSignature(node, state.cache)} ${allocation.width ?? "-"} ${allocation.height ?? "-"} ${depth}`;
	const hit = state.cache.placed.get(cacheKey) as PlacedNode | undefined;
	if (hit) {
		state.reusedSubtrees.add(node.id);
		return hit;
	}

	const sizings = (state.sizings.get(node.id) ?? 0) + 1;
	state.sizings.set(node.id, sizings);
	const previous = state.lastResult.get(node.id);
	if (sizings > 2 && previous) {
		// §7.8's convergence bound, enforced rather than merely reported. A node
		// may be sized on the bottom-up Hug pass and once more after a permitted
		// remeasurement; a third attempt means something is trying to iterate to
		// a fixpoint, which the O(nodes) contract forbids. Return the second
		// result — and crucially do NOT recurse, which is what keeps nested Fill
		// containers from re-resolving their subtrees exponentially.
		state.issues.push(
			createLayoutIssue("layout-measurement-missing", {
				nodeId: node.id,
				message: `Node "${node.id}" would be sized a third time in one resolution; the second result is kept (TD §7.8 bounds a pass at two sizings per node).`,
			}),
		);
		return previous;
	}

	if (depth >= MAX_TREE_DEPTH) {
		// The resolver NEVER throws for depth (§14). The walkers keep throwing
		// `CanvasIRDepthError` → `excessive-tree-depth` as the document-level
		// fact; this is the resolution-level consequence, and a document
		// legitimately produces both.
		state.issues.push(
			createLayoutIssue("layout-depth-exceeded", {
				nodeId: node.id,
				message: `Layout below "${node.id}" was not computed: the subtree exceeds MAX_TREE_DEPTH=${MAX_TREE_DEPTH}. Its stored geometry is used unchanged.`,
			}),
		);
		return {
			source: node,
			bounds: node.bounds,
			transform: node.transform,
			shape: shapeExtent(node.transform, node.bounds),
			children: [],
		};
	}

	const result = isAutoLayoutFrame(node)
		? resolveAutoLayoutFrame(node, allocation, depth, state)
		: resolvePlainNode(node, allocation, depth, state);
	state.lastResult.set(node.id, result);
	state.nextPlaced.set(cacheKey, result);
	return result;
}

function shapeExtent(
	transform: CanvasTransform,
	bounds: CanvasBounds,
): BoundsExtent {
	return transformedBoundsExtent(
		{ ...transform, x: 0, y: 0 },
		bounds.width,
		bounds.height,
	);
}

/**
 * Apply an allocation to a node that sizes itself from its own content.
 *
 * Returns the resolved bounds plus the transform with scale normalised on every
 * axis layout controls.
 *
 * **Scale normalisation (§7.7), and the reading this implements.** On an axis
 * layout owns, the resolver sets scale to 1 and writes the footprint-space
 * value it decided into `bounds`, so the stored number and the visible number
 * are the same and the next resolution reads back exactly what this one wrote.
 * For **Fill** that value is the allocated extent; for **Hug** it is the
 * intrinsic content size, measured in the box's own units — which with scale 1
 * *are* footprint units.
 *
 * Folding the prior scale in on a Hug axis instead (bounds := intrinsic ×
 * scale) was the other candidate reading of "folds the prior scale into
 * bounds". It is rejected because it does not reach a fixed point: a hugging
 * node with `scaleX: 2` would resolve to `200`, and the *next* resolution
 * would measure the same content at `100` and resolve to `100`. A document
 * that changes the first two times it is opened is worse than one that
 * normalises once. Rotation and skew are preserved untouched either way, and
 * Fixed axes are not normalised at all — layout does not own their size.
 */
function applySizing(
	node: CanvasNode,
	allocation: Allocation,
	intrinsic: CanvasBounds,
	widthSizing: CanvasLayoutSizing,
	heightSizing: CanvasLayoutSizing,
): { bounds: CanvasBounds; transform: CanvasTransform } {
	const controlledWidth = widthSizing !== "fixed";
	const controlledHeight = heightSizing !== "fixed";
	const transform: CanvasTransform = {
		...node.transform,
		...(controlledWidth ? { scaleX: 1 } : {}),
		...(controlledHeight ? { scaleY: 1 } : {}),
	};

	if (!controlledWidth && !controlledHeight) {
		return { bounds: node.bounds, transform };
	}

	const m = shapeMatrix(transform);
	// Hug takes the intrinsic box directly (already in scale-1 units); Fill
	// takes the allocated footprint extent and solves back to a box.
	const hugExtent = matrixBoundsExtent(m, intrinsic.width, intrinsic.height);
	const targetX = controlledWidth
		? widthSizing === "fill"
			? (allocation.width ?? hugExtent.maxX - hugExtent.minX)
			: hugExtent.maxX - hugExtent.minX
		: undefined;
	const targetY = controlledHeight
		? heightSizing === "fill"
			? (allocation.height ?? hugExtent.maxY - hugExtent.minY)
			: hugExtent.maxY - hugExtent.minY
		: undefined;

	return {
		bounds: solveBounds(m, targetX, targetY, {
			width: controlledWidth ? intrinsic.width : node.bounds.width,
			height: controlledHeight ? intrinsic.height : node.bounds.height,
		}),
		transform,
	};
}

/** A node that is not an Auto Layout frame: groups, plain frames, and leaves. */
function resolvePlainNode(
	node: CanvasNode,
	allocation: Allocation,
	depth: number,
	state: ResolveState,
): PlacedNode {
	const widthSizing = effectiveSizing(node, "widthSizing", state.graph);
	const heightSizing = effectiveSizing(node, "heightSizing", state.graph);

	let intrinsic = node.bounds;
	if (widthSizing === "hug" || heightSizing === "hug") {
		// The wrap constraint for rich text is the width this node has already
		// been given, so a Fill/Fixed width drives the height measurement.
		const widthConstraint =
			widthSizing === "hug"
				? undefined
				: (allocation.width ?? node.bounds.width);
		const measured = measureIntrinsicSize(
			node,
			state.measurement,
			widthConstraint,
		);
		if (measured.issue) state.issues.push(measured.issue);
		intrinsic = {
			width: widthSizing === "hug" ? measured.size.width : node.bounds.width,
			height:
				heightSizing === "hug" ? measured.size.height : node.bounds.height,
		};
	}

	const { bounds, transform } = applySizing(
		node,
		allocation,
		intrinsic,
		widthSizing,
		heightSizing,
	);
	const finalBounds = quantiseBounds(bounds);

	// A plain container does not position its children — they keep their stored
	// transforms, which is exactly the pre-Auto-Layout behaviour every existing
	// document depends on.
	const children = childrenOf(node).map((child) =>
		resolveNode(child, {}, depth + 1, state),
	);

	return {
		source: node,
		bounds: finalBounds,
		transform: quantiseTransform(transform),
		shape: shapeExtent(transform, finalBounds),
		children,
	};
}

function resolveAutoLayoutFrame(
	frame: CanvasFrameNode & {
		autoLayout: NonNullable<CanvasFrameNode["autoLayout"]>;
	},
	allocation: Allocation,
	depth: number,
	state: ResolveState,
): PlacedNode {
	const { direction, padding, gap, primaryAlign, crossAlign } =
		frame.autoLayout;
	const axis = axisFor(direction);
	const all = childrenOf(frame);
	// Hidden children are NOT filtered: `visible` is a paint property (§7.2).
	const flow = all.filter((child) => !isAbsolute(child));
	const absolute = all.filter(isAbsolute);

	const mainSizing = effectiveSizing(frame, axis.mainSizingField, state.graph);
	const crossSizing = effectiveSizing(
		frame,
		axis.crossSizingField,
		state.graph,
	);
	const padMainStart = axis.mainPaddingStart(padding);
	const padMainEnd = axis.mainPaddingEnd(padding);
	const padCrossStart = axis.crossPaddingStart(padding);
	const padCrossEnd = axis.crossPaddingEnd(padding);
	// NEVER clamped beyond the n-1 count: an overfull frame overflows (§7.3).
	const gapTotal = Math.max(0, flow.length - 1) * gap;

	// --- provisional pass: what do the children need? ------------------------
	// Run for EVERY flow child, not only when this frame Hugs. A Hug child's
	// resolved extent differs from its stored one, so a fixed-size frame that
	// skipped this would compute `fixedTotal` from stale stored bounds and
	// mis-place every sibling after it.
	const provisional = flow.map((child) =>
		resolveNode(child, {}, depth + 1, state),
	);

	let hugMain = padMainStart + padMainEnd + gapTotal;
	let hugCross = 0;
	for (const placed of provisional) {
		hugMain += axis.mainExtent(placed.shape);
		hugCross = Math.max(hugCross, axis.crossExtent(placed.shape));
	}
	hugCross += padCrossStart + padCrossEnd;

	// The frame's own size. Hug targets are in the frame's LOCAL units (they are
	// sums over child footprints, which live in this frame's coordinate space);
	// Fill targets are footprint extents in the PARENT's space. `applySizing`
	// keeps the two straight per axis, so they are passed separately rather than
	// collapsed into one "own size" that would silently mean both.
	const fields = sizingByDimension(axis, mainSizing, crossSizing);
	const frameAllocation: Allocation = {};
	if (mainSizing === "fill" && allocation[axis.mainDimension] !== undefined) {
		frameAllocation[axis.mainDimension] = allocation[axis.mainDimension];
	}
	if (crossSizing === "fill" && allocation[axis.crossDimension] !== undefined) {
		frameAllocation[axis.crossDimension] = allocation[axis.crossDimension];
	}
	const frameSizing = applySizing(
		frame,
		frameAllocation,
		axis.createBounds(hugMain, hugCross),
		fields.width,
		fields.height,
	);
	const frameBounds = quantiseBounds(frameSizing.bounds);
	const frameShape = shapeExtent(frameSizing.transform, frameBounds);

	// Inner space is measured in the frame's OWN local units, because that is
	// the coordinate space its children are positioned in. Using the frame's
	// footprint (its extent in the *parent's* space) would scale every child
	// position by the frame's own rotation or scale.
	const innerMain = Math.max(
		0,
		axis.mainSize(frameBounds) - padMainStart - padMainEnd,
	);
	const innerCross = Math.max(
		0,
		axis.crossSize(frameBounds) - padCrossStart - padCrossEnd,
	);

	// --- Fill distribution ---------------------------------------------------
	let fixedTotal = 0;
	let fillCount = 0;
	for (const [index, child] of flow.entries()) {
		if (effectiveSizing(child, axis.mainSizingField, state.graph) === "fill") {
			fillCount += 1;
			continue;
		}
		const known = provisional[index] as PlacedNode;
		fixedTotal += axis.mainExtent(known.shape);
	}
	const remaining = innerMain - gapTotal - fixedTotal;
	// Equal division among Fill children — weighted Fill is out of scope. Only
	// this clamps; `gapTotal` above deliberately does not.
	const fillSize =
		fillCount > 0 ? Math.max(0, quantise(remaining / fillCount)) : 0;

	// --- final child resolution and Flow placement ---------------------------
	const sized: PlacedNode[] = flow.map((child, index) => {
		const childMain = effectiveSizing(child, axis.mainSizingField, state.graph);
		const childCross = effectiveSizing(
			child,
			axis.crossSizingField,
			state.graph,
		);
		const childAllocation: Allocation = {};
		if (childMain === "fill") childAllocation[axis.mainDimension] = fillSize;
		if (childCross === "fill")
			childAllocation[axis.crossDimension] = innerCross;
		// Reuse the provisional result when nothing the parent decided can
		// change it — this is what keeps the pass at ≤2 sizings per node.
		const reusable =
			provisional[index] !== undefined &&
			childMain !== "fill" &&
			childCross !== "fill";
		return reusable
			? (provisional[index] as PlacedNode)
			: resolveNode(child, childAllocation, depth + 1, state);
	});

	let contentMain = gapTotal;
	for (const placed of sized) contentMain += axis.mainExtent(placed.shape);
	const freeMain = innerMain - contentMain;
	if (freeMain < -EPSILON) {
		reportOverflow(
			state,
			frame.id,
			axis.mainAxis,
			sized.map((p) => p.source.id),
			`Frame "${frame.id}" has ${quantise(-freeMain)} more ${axis.mainAxis} content than space`,
		);
	}
	const usableFree = Math.max(0, freeMain);
	const startOffset =
		primaryAlign === "start"
			? 0
			: primaryAlign === "center"
				? usableFree / 2
				: usableFree;

	let cursor = padMainStart + startOffset;
	const overflowingCross: string[] = [];
	const placedFlow: PlacedNode[] = sized.map((placed) => {
		const childMain = axis.mainExtent(placed.shape);
		const childCross = axis.crossExtent(placed.shape);
		const crossFree = innerCross - childCross;
		if (crossFree < -EPSILON) overflowingCross.push(placed.source.id);
		const usableCrossFree = Math.max(0, crossFree);
		const crossOffset =
			crossAlign === "start"
				? 0
				: crossAlign === "center"
					? usableCrossFree / 2
					: usableCrossFree;
		// The footprint's own origin offset must be added back: a rotated child's
		// extent does not start at its transform origin.
		const position = axis.createPosition(
			cursor - axis.mainExtentStart(placed.shape),
			padCrossStart + crossOffset - axis.crossExtentStart(placed.shape),
		);
		cursor += childMain + gap;
		return {
			...placed,
			transform: quantiseTransform({
				...placed.transform,
				x: position.x,
				y: position.y,
			}),
		};
	});
	if (overflowingCross.length > 0) {
		reportOverflow(
			state,
			frame.id,
			axis.crossAxis,
			overflowingCross,
			`Frame "${frame.id}" is too small on its ${axis.crossAxis} axis for`,
		);
	}

	// --- Absolute children ---------------------------------------------------
	// Excluded from flow count, gap and Hug; their stored `transform.x/y` stays
	// authoritative and is measured from the frame's BORDER-BOX origin, not the
	// padding box, so changing padding never moves a badge (§7.6).
	const placedAbsolute = absolute.map((child) =>
		resolveNode(child, {}, depth + 1, state),
	);

	// Emit children in the source `children` order so the resolved tree and the
	// layer tree never disagree, even though they were sized in two groups.
	const byId = new Map<string, PlacedNode>();
	for (const placed of placedFlow) byId.set(placed.source.id, placed);
	for (const placed of placedAbsolute) byId.set(placed.source.id, placed);
	const children = all
		.map((child) => byId.get(child.id))
		.filter((placed): placed is PlacedNode => placed !== undefined);

	return {
		source: frame,
		bounds: frameBounds,
		transform: quantiseTransform(frameSizing.transform),
		shape: frameShape,
		children,
	};
}

/** Map main/cross sizing back onto the width/height fields `applySizing` takes. */
function sizingByDimension(
	axis: AxisAdapter,
	mainSizing: CanvasLayoutSizing,
	crossSizing: CanvasLayoutSizing,
): { width: CanvasLayoutSizing; height: CanvasLayoutSizing } {
	return axis.mainDimension === "width"
		? { width: mainSizing, height: crossSizing }
		: { width: crossSizing, height: mainSizing };
}

/**
 * Report insufficient space **once per container and axis** (§7.4).
 *
 * Not once per affected child: diagnostic ordering *and count* are part of the
 * determinism contract (AL-RESOLVE-002), so letting the array length vary with
 * child count for what is a single container-level condition would be a
 * determinism defect rather than a verbosity preference. The affected children
 * are named in the message instead.
 */
function reportOverflow(
	state: ResolveState,
	frameId: string,
	axis: CanvasLayoutDirection,
	childIds: readonly string[],
	prefix: string,
): void {
	const key = `${frameId} ${axis}`;
	if (state.reportedOverflow.has(key)) return;
	state.reportedOverflow.add(key);
	state.issues.push(
		createLayoutIssue("layout-insufficient-space", {
			nodeId: frameId,
			axis,
			message: `${prefix}: ${childIds.join(", ")}. Content overflows; gaps never collapse.`,
		}),
	);
}

/** Walk the placed tree, composing world transforms and emitting records. */
function emitRecords(
	placed: PlacedNode,
	parentWorld: AffineMatrix,
	parentId: CanvasResolvedNodeId | undefined,
	records: Map<CanvasResolvedNodeId, CanvasResolvedNodeRecord>,
	cache: LayoutCacheState,
): CanvasResolvedNodeId {
	const id = toResolvedNodeId(placed.source.id);
	const local = toAffineMatrix(placed.transform);
	const worldTransform = multiplyMatrix(parentWorld, local);
	const childIds = placed.children.map((child) =>
		emitRecords(child, worldTransform, id, records, cache),
	);
	const candidate: CanvasResolvedNodeRecord = {
		id,
		sourceNodeId: placed.source.id,
		...(parentId ? { parentId } : {}),
		childIds,
		node: placed.source,
		geometry: {
			localTransform: placed.transform,
			bounds: placed.bounds,
			worldTransform,
			worldAabb: matrixBoundsExtent(
				worldTransform,
				placed.bounds.width,
				placed.bounds.height,
			),
			layoutFootprint: transformedBoundsExtent(
				placed.transform,
				placed.bounds.width,
				placed.bounds.height,
			),
		},
	};
	// Hand back the PREVIOUS object when nothing observable changed, so a
	// renderer can memoise on record identity (TD §5.4).
	records.set(id, reuseRecord(candidate, cache.records.get(placed.source.id)));
	return id;
}

const IDENTITY: AffineMatrix = [1, 0, 0, 1, 0, 0];

/**
 * Resolve a document's Auto Layout into one shared geometry tree.
 *
 * `options` is a required parameter with entirely optional fields — PRD §9.3
 * writes it as required while TD §5.4 makes every field optional, and this
 * satisfies both readings (plan §10.1).
 */
export function resolveCanvasLayout(
	ir: CanvasIR,
	options: CanvasLayoutResolveOptions,
): CanvasResolvedDocument {
	const opts = options ?? {};
	const pages = opts.pageIds
		? ir.pages.filter((page) => opts.pageIds?.includes(page.id))
		: ir.pages;

	const manifestHash = opts.measurement?.manifestHash ?? "";
	// The warm state is looked up from the caller-supplied previous document
	// rather than held in a module-level singleton keyed by IR: two editors, or
	// an editor and an export worker, resolve different documents in one
	// process and must not share a cache.
	const cache = createCacheState(
		ir.assets,
		manifestHash,
		opts.previous ? documentCaches.get(opts.previous) : undefined,
	);

	const inputHash = computeInputHash(ir, manifestHash);

	const state: ResolveState = {
		graph: buildSizingGraph(ir),
		measurement: createMeasurementContext(ir.assets, {
			...(opts.measurement ? { provider: opts.measurement } : {}),
			...(opts.richTextDefaults
				? { richTextDefaults: opts.richTextDefaults }
				: {}),
		}),
		issues: [],
		sizings: new Map(),
		lastResult: new Map(),
		reportedOverflow: new Set(),
		cache,
		nextPlaced: new Map(),
		reusedSubtrees: new Set(),
	};

	// A stamp whose inputs no longer hash the same describes geometry from an
	// earlier revision. Reported rather than silently trusted or silently
	// discarded, because a consumer rendering from the materialized cache needs
	// to know it should recompute before editing or exporting (TD §14).
	if (
		ir.layoutMaterialization &&
		ir.layoutMaterialization.inputHash !== inputHash
	) {
		state.issues.push(
			createLayoutIssue("layout-materialization-stale", {
				message: `The materialized layout cache was resolved from different inputs (stamped "${ir.layoutMaterialization.inputHash}", current "${inputHash}"); recompute before edit or export.`,
			}),
		);
	}

	const records = new Map<CanvasResolvedNodeId, CanvasResolvedNodeRecord>();
	const pageRoots = new Map<string, readonly CanvasResolvedNodeId[]>();
	for (const page of pages) {
		const placed = resolveNode(page.root, {}, 0, state);
		pageRoots.set(page.id, [
			emitRecords(placed, IDENTITY, undefined, records, cache),
		]);
	}

	// The graph's issues are document invariants (level 3); the state's are
	// resolution diagnostics (level 4). Both belong in ONE array ordered by the
	// fully specified TD §14 key — concatenating them would leave the output
	// dependent on the order the solver happened to visit nodes, which is
	// exactly what AC-008's determinism contract forbids.
	const ordered = orderLayoutIssues(
		[...state.graph.issues, ...state.issues],
		buildDocumentOrder(ir),
	);
	const diagnostics = ordered.slice(0, MAX_RETAINED_DIAGNOSTICS);

	const resolved: CanvasResolvedDocument = {
		source: ir,
		records,
		pageRoots,
		diagnostics,
		// Truncation is never silent (`limits.ts`): a caller that sees 1,000
		// diagnostics and a zero here knows it has the whole story, and one that
		// sees a non-zero knows not to treat the list as exhaustive.
		truncatedDiagnostics: ordered.length - diagnostics.length,
		engineVersion: 1,
		inputHash,
	};
	documentCaches.set(
		resolved,
		advanceCacheState(cache, state.nextPlaced, records),
	);
	reuseCounts.set(resolved, state.reusedSubtrees.size);
	return resolved;
}

/**
 * Warm state, hung off the resolved document that produced it.
 *
 * A `WeakMap` rather than a field on `CanvasResolvedDocument`, because
 * T-M2-09's DoD requires cache internals stay out of the public API — a field
 * would put the solver's private placement shape in `check:api-snapshot`. It
 * also means the cache is collected with the document it belongs to, with no
 * eviction policy to get wrong.
 */
const documentCaches = new WeakMap<CanvasResolvedDocument, LayoutCacheState>();

/**
 * The measurement-manifest identity a resolution was produced under.
 *
 * Needed by `materialize.ts` to re-stamp over the document it writes, and read
 * from the private cache state rather than from a public field so the resolved
 * document's shape stays as TD §5.4 published it.
 */
export function resolutionManifestHash(
	document: CanvasResolvedDocument,
): string {
	return documentCaches.get(document)?.manifestHash ?? "";
}

/**
 * How many subtrees the last resolution reused, for tests and host telemetry.
 *
 * Exposed as a function over the resolved document rather than a field, for the
 * same api-surface reason as {@link documentCaches}.
 */
export function reusedSubtreeCount(
	document: CanvasResolvedDocument,
): number | undefined {
	return reuseCounts.get(document);
}

const reuseCounts = new WeakMap<CanvasResolvedDocument, number>();

/**
 * Fingerprint of the inputs a resolution depended on.
 *
 * Stamped into `CanvasLayoutMaterialization.inputHash`, so a collision here
 * means a stale cache reads as fresh — which is why this uses the 64-bit
 * fingerprint rather than the 32-bit id one.
 */
export function computeInputHash(ir: CanvasIR, manifestHash: string): string {
	return fingerprint64(
		`${ir.version}|${manifestHash}|${JSON.stringify(ir.pages)}`,
	);
}
