import type { BoundsExtent } from "../geometry/affine.js";
import type {
	CanvasBounds,
	CanvasInsets,
	CanvasLayoutDirection,
} from "../ir/types.js";

/**
 * @file Axis abstraction (TD §7.1) — the ONLY place direction is branched on.
 *
 * Horizontal and vertical Auto Layout are the same algorithm with `x`/`width`
 * and `y`/`height` swapped. Writing it twice, or threading
 * `if (direction === "horizontal")` through the solver, is how the two
 * directions drift: a fix applied to one and forgotten on the other is
 * invisible until an author transposes a frame.
 *
 * So the solver speaks only `main`/`cross` and never names a direction.
 * TS-16 (axis transposition) is the executable form of that claim — a vertical
 * fixture must resolve to the exact transpose of its horizontal twin — and
 * T-M2-02's acceptance criterion is that grepping the solver for
 * `"horizontal"` finds only this file and user-facing labels.
 */

/**
 * Per-direction accessors over bounds, extents, positions and insets.
 *
 * Extends TD §7.1's published shape with `mainExtent`/`crossExtent`, because
 * §7.7 makes **all** solver arithmetic footprint-space: the solver reads sizes
 * off an `Aabb` (a transformed extent), not off a raw `CanvasBounds`. Without
 * these two the solver would have to convert an extent into a bounds object
 * per node per pass just to ask its main size — an allocation, and a second
 * place where "which axis is main" would have to be decided.
 */
export interface AxisAdapter {
	/** The direction this adapter lays out along. */
	readonly mainAxis: CanvasLayoutDirection;
	/** The perpendicular direction. Used for diagnostics' `axis` field and cross sizing. */
	readonly crossAxis: CanvasLayoutDirection;
	/** `CanvasLayoutItem` field controlling the main axis. */
	readonly mainSizingField: "widthSizing" | "heightSizing";
	/** `CanvasLayoutItem` field controlling the cross axis. */
	readonly crossSizingField: "widthSizing" | "heightSizing";
	/** `CanvasBounds` key the main axis sizes. */
	readonly mainDimension: "width" | "height";
	/** `CanvasBounds` key the cross axis sizes. */
	readonly crossDimension: "width" | "height";

	mainSize(bounds: CanvasBounds): number;
	crossSize(bounds: CanvasBounds): number;
	/** Main-axis span of a transformed extent (footprint space). */
	mainExtent(extent: BoundsExtent): number;
	/** Cross-axis span of a transformed extent (footprint space). */
	crossExtent(extent: BoundsExtent): number;
	/** Main-axis minimum of a transformed extent — the offset a rotation introduces. */
	mainExtentStart(extent: BoundsExtent): number;
	/** Cross-axis minimum of a transformed extent. */
	crossExtentStart(extent: BoundsExtent): number;

	createBounds(main: number, cross: number): CanvasBounds;
	createPosition(main: number, cross: number): { x: number; y: number };

	mainPaddingStart(insets: CanvasInsets): number;
	mainPaddingEnd(insets: CanvasInsets): number;
	crossPaddingStart(insets: CanvasInsets): number;
	crossPaddingEnd(insets: CanvasInsets): number;
}

/**
 * The two `CanvasLayoutItem` sizing fields, in a stable order.
 *
 * Iterating this rather than hand-listing the pair at each site is what keeps
 * "did we check both axes?" a compile-time question.
 */
export const SIZING_FIELDS = ["widthSizing", "heightSizing"] as const;

/**
 * Which direction each sizing field controls.
 *
 * Lives with the axis abstraction rather than in the validator so every
 * consumer — validator, dependency graph, solver — derives an issue's `axis`
 * from one table. It is also what lets those modules stay free of direction
 * literals, which T-M2-02's acceptance criterion asserts by grep.
 */
export const SIZING_FIELD_AXIS = {
	widthSizing: "horizontal",
	heightSizing: "vertical",
} as const satisfies Record<
	(typeof SIZING_FIELDS)[number],
	CanvasLayoutDirection
>;

const HORIZONTAL: AxisAdapter = {
	mainAxis: "horizontal",
	crossAxis: "vertical",
	mainSizingField: "widthSizing",
	crossSizingField: "heightSizing",
	mainDimension: "width",
	crossDimension: "height",

	mainSize: (bounds) => bounds.width,
	crossSize: (bounds) => bounds.height,
	mainExtent: (extent) => extent.maxX - extent.minX,
	crossExtent: (extent) => extent.maxY - extent.minY,
	mainExtentStart: (extent) => extent.minX,
	crossExtentStart: (extent) => extent.minY,

	createBounds: (main, cross) => ({ width: main, height: cross }),
	createPosition: (main, cross) => ({ x: main, y: cross }),

	mainPaddingStart: (insets) => insets.left,
	mainPaddingEnd: (insets) => insets.right,
	crossPaddingStart: (insets) => insets.top,
	crossPaddingEnd: (insets) => insets.bottom,
};

const VERTICAL: AxisAdapter = {
	mainAxis: "vertical",
	crossAxis: "horizontal",
	mainSizingField: "heightSizing",
	crossSizingField: "widthSizing",
	mainDimension: "height",
	crossDimension: "width",

	mainSize: (bounds) => bounds.height,
	crossSize: (bounds) => bounds.width,
	mainExtent: (extent) => extent.maxY - extent.minY,
	crossExtent: (extent) => extent.maxX - extent.minX,
	mainExtentStart: (extent) => extent.minY,
	crossExtentStart: (extent) => extent.minX,

	createBounds: (main, cross) => ({ width: cross, height: main }),
	createPosition: (main, cross) => ({ x: cross, y: main }),

	mainPaddingStart: (insets) => insets.top,
	mainPaddingEnd: (insets) => insets.bottom,
	crossPaddingStart: (insets) => insets.left,
	crossPaddingEnd: (insets) => insets.right,
};

/**
 * The adapter for a direction.
 *
 * Returns one of two frozen module-level singletons rather than constructing
 * per call: adapters are stateless, and a fresh object per frame per pass
 * would allocate once per Auto Layout container on a hot path for no benefit.
 */
export function axisFor(direction: CanvasLayoutDirection): AxisAdapter {
	return direction === "horizontal" ? HORIZONTAL : VERTICAL;
}
