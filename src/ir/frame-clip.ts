import { hasDrawablePathGeometry, isValidPathD } from "../path-data.js";
import type { CanvasCornerRadii, CanvasFrameShape } from "./types.js";

/**
 * Why a declared {@link CanvasFrameShape} could not be honoured. Every case is
 * reachable at runtime even though {@link CanvasFrameShapeSchema} rejects some
 * of them: nodes are routinely constructed in TypeScript without going through
 * the schema, the schema itself only requires a non-empty `d`, and the IR's
 * `looseObject` posture means a newer peer's shape kind survives a round-trip
 * through a build that has never heard of it.
 */
export type FrameClipDegradation =
	/** A `kind` this build does not implement (a newer peer, or a hand-built node). */
	| "unknown-shape-kind"
	/** A known `kind` whose numbers/path data cannot describe a real outline. */
	| "invalid-shape-geometry"
	/** `path` data carrying characters the SVG attribute allowlist rejects. */
	| "unsafe-path-data";

/**
 * Where the resolved geometry came from.
 *
 * `"default"` and `"declared"` are the mask analogue of the distinction
 * {@link resolveNodeEffects} draws between an absent `effects` array and an
 * explicitly empty one: a frame that never declared a shape inherits the
 * rectangle, while a frame declaring `{ kind: "rect" }` has *deliberately no
 * shape mask*. Both clip to the same rectangle, and they must stay
 * distinguishable — that is how an edit removes a mask (writing the rectangle)
 * without deleting the frame's history, and how UI can tell "unset" from
 * "explicitly rectangular".
 */
export type FrameClipShapeSource =
	/** No `shape` field — the rectangle every frame clipped to before ADR 0008. */
	| "default"
	/** The frame's own `shape`, honoured as written. */
	| "declared"
	/** A `shape` that could not be honoured; the rectangle stands in for it. */
	| "degraded";

/** The rectangle a frame clips to when it declares no shape, or declares one that cannot be honoured. */
const RECT_SHAPE: CanvasFrameShape = { kind: "rect" };

/** A frame's clip, fully resolved: is it clipping, to what, and on whose authority. */
export interface ResolvedFrameClipShape {
	/**
	 * Is the frame clipping at all? `false` whenever `clip !== true`, in which
	 * case every other field describes geometry that is present but inert —
	 * `shape` is *not* a second, silent clipping trigger (ADR 0008 decision 2).
	 */
	readonly clipped: boolean;
	/** The geometry to clip to. Never absent: an unshaped frame resolves to `{ kind: "rect" }`. */
	readonly shape: CanvasFrameShape;
	/**
	 * Uniform corner radius, resolved. Present only for `kind: "rect"` with a
	 * positive `radius` and no `cornerRadii` — the two existing clip paths both
	 * let per-corner radii win outright, and both ignore a zero radius.
	 */
	readonly radius?: number;
	/** Per-corner radii, resolved. Present only for `kind: "rect"` when the frame sets them. */
	readonly cornerRadii?: CanvasCornerRadii;
	readonly source: FrameClipShapeSource;
	/** Why the declared shape was rejected. Present if and only if `source` is `"degraded"`. */
	readonly degradation?: FrameClipDegradation;
}

/** A polygon side count / star point count: an integer of at least 3, matching `IntegerAtLeastThree` in `validators.ts`. */
function isVertexCount(value: number): boolean {
	return Number.isInteger(value) && value >= 3;
}

/** A ratio in 0..1, matching `UnitInterval` in `validators.ts`. */
function isUnitInterval(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Can this shape be turned into an outline? Returns the reason it cannot, or
 * `undefined` when it can. Deliberately structural rather than a Zod parse: the
 * resolver is on the render path of every clipping frame in a document, and
 * `ir/` must not depend on the schema layer to answer a question about a plain
 * object it was handed.
 */
function frameShapeDegradation(
	shape: CanvasFrameShape,
): FrameClipDegradation | undefined {
	switch (shape.kind) {
		case "rect":
		case "ellipse":
			return undefined;
		case "polygon":
			return isVertexCount(shape.sides) ? undefined : "invalid-shape-geometry";
		case "star":
			return isVertexCount(shape.points) &&
				isUnitInterval(shape.innerRadiusRatio)
				? undefined
				: "invalid-shape-geometry";
		case "path":
			// EVERY reason a `path` cannot be honoured is decided here, by the ONE
			// resolver, because each consumer that decided one of them for itself
			// disagreed with the others. `cp4-001` originally left path data to
			// "the serializer's existing `PATH_D_RE` guard on the way out" on the
			// grounds that rank 1 could not import rank 5's regex; that split is
			// what produced defect D-1 — SVG vetted the CHARACTERS and Konva vetted
			// the GEOMETRY, so `d: "Z"` passed one and failed the other, and the
			// export emitted an empty `<clipPath>` that erased the frame's whole
			// content while the editor drew it normally. Both predicates now live
			// at rank 0 (`path-data.ts`), so this is one decision both renderers
			// read rather than two they each make.
			//
			// The three outcomes stay distinct because they are genuinely different
			// authoring mistakes, and the SVG warning quotes them.
			if (typeof shape.d !== "string" || shape.d.trim().length === 0) {
				return "invalid-shape-geometry";
			}
			if (!isValidPathD(shape.d)) return "unsafe-path-data";
			return hasDrawablePathGeometry(shape.d)
				? undefined
				: "invalid-shape-geometry";
		default:
			return "unknown-shape-kind";
	}
}

/** Rounding, resolved for the rectangle case only — per-corner radii win, and a zero radius is no radius. */
function rectRounding(frame: {
	radius?: number;
	cornerRadii?: CanvasCornerRadii;
}): Pick<ResolvedFrameClipShape, "radius" | "cornerRadii"> {
	if (frame.cornerRadii) return { cornerRadii: frame.cornerRadii };
	if (frame.radius !== undefined && frame.radius > 0) {
		return { radius: frame.radius };
	}
	return {};
}

/**
 * The ONE frame-clip resolver (ADR 0008 decision 2) — every consumer (the
 * editor's Konva `clipFunc`, the SVG serializer's `<clipPath>`, the inspector)
 * resolves a frame's clip through this, so canvas, export, and UI can never
 * disagree about what a frame clips to. It is the mask counterpart of
 * {@link resolveNodeEffects} and follows the same contract: pure, total, and
 * never throwing — a frame it cannot honour degrades rather than failing.
 *
 * Precedence, in order:
 *
 * 1. **`clip` is the only on/off switch.** `clip !== true` resolves to
 *    `clipped: false`; a `shape` on such a frame stays inert. Reading `shape`
 *    as a second clipping trigger would be a parallel clipping model, which is
 *    the thing ADR 0008 decision 2 rules out.
 * 2. **An absent `shape` inherits the rectangle** (`source: "default"`), with
 *    the frame's `cornerRadii`/`radius` rounding — byte-for-byte today's
 *    behaviour, so every pre-ADR-0008 document resolves exactly as before.
 * 3. **A present `shape` wins outright, including `{ kind: "rect" }`**
 *    (`source: "declared"`), which means *deliberately no shape mask* and stays
 *    distinguishable from case 2.
 * 4. **`radius`/`cornerRadii` reach the result only for `kind: "rect"`.** Every
 *    other kind resolves without rounding — resolved here once rather than
 *    re-decided by each renderer.
 * 5. **A shape that cannot be honoured degrades to the rectangle**
 *    (`source: "degraded"` plus a {@link FrameClipDegradation}) instead of
 *    throwing. The document keeps the field — degradation is a rendering
 *    decision, never a mutation — and the `unsupported-frame-clip-shape`
 *    invariant reports it as a diagnostic.
 *
 * Takes a structural subset rather than `CanvasFrameNode` so a caller holding
 * only a frame's clip fields (an inspector row, a command payload) can resolve
 * without materializing a node.
 */
export function resolveFrameClipShape(frame: {
	clip?: boolean;
	shape?: CanvasFrameShape;
	radius?: number;
	cornerRadii?: CanvasCornerRadii;
}): ResolvedFrameClipShape {
	const clipped = frame.clip === true;
	const declared = frame.shape;

	// `null` is JSON's spelling of "no value", so it inherits the rectangle
	// exactly like an absent field. Every other non-shape falls through to the
	// degradation check, which cannot throw on it.
	if (declared === undefined || declared === null) {
		return {
			clipped,
			shape: RECT_SHAPE,
			...rectRounding(frame),
			source: "default",
		};
	}

	const degradation = frameShapeDegradation(declared);
	if (degradation !== undefined) {
		return {
			clipped,
			shape: RECT_SHAPE,
			...rectRounding(frame),
			source: "degraded",
			degradation,
		};
	}

	// The declared object itself, not a copy: the IR's schemas are loose, so a
	// newer peer's extra keys on the shape must reach consumers intact.
	return declared.kind === "rect"
		? { clipped, shape: declared, ...rectRounding(frame), source: "declared" }
		: { clipped, shape: declared, source: "declared" };
}
