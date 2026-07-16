import { resolveNodeEffects } from "../ir/effects.js";
import type {
	CanvasArrowHead,
	CanvasCornerRadii,
	CanvasEffect,
	CanvasFill,
	CanvasFontFamily,
	CanvasImageAdjustments,
	CanvasNode,
	CanvasNodeKind,
	CanvasShadow,
	CanvasTextAlign,
} from "../ir/types.js";

/**
 * Copy/paste style (C-05, FR-120/121). A `CanvasNodeStyle` is the portable
 * style payload: appearance only — never id, position, size, rotation,
 * children, asset ids, or text content. Shadows travel exclusively as
 * `effects` (extraction lifts a legacy `shadow` through core's ONE resolver),
 * so pasting always writes the C-03 model.
 */
export interface CanvasNodeStyle {
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	strokeOpacity?: number;
	strokeDash?: number[];
	strokeCap?: "butt" | "round" | "square";
	strokeJoin?: "miter" | "round" | "bevel";
	arrowStart?: CanvasArrowHead;
	arrowEnd?: CanvasArrowHead;
	opacity?: number;
	blendMode?: string;
	radius?: number;
	cornerRadii?: CanvasCornerRadii;
	effects?: CanvasEffect[];
	fontFamily?: CanvasFontFamily;
	fontSize?: number;
	fontWeight?: string;
	align?: CanvasTextAlign;
	adjustments?: CanvasImageAdjustments;
}

export type CanvasNodeStyleKey = keyof CanvasNodeStyle;

const BASE_KEYS: readonly CanvasNodeStyleKey[] = ["opacity", "blendMode"];
const STROKE_KEYS: readonly CanvasNodeStyleKey[] = [
	"stroke",
	"strokeWidth",
	"strokeOpacity",
	"strokeDash",
	"strokeCap",
	"strokeJoin",
];
const ARROW_KEYS: readonly CanvasNodeStyleKey[] = ["arrowStart", "arrowEnd"];
const TEXT_KEYS: readonly CanvasNodeStyleKey[] = [
	"fontFamily",
	"fontSize",
	"fontWeight",
	"align",
];

/**
 * The FR-121 compatible-property matrix: which style keys each node kind can
 * receive. Kinds absent from a key's list IGNORE that key on paste (reported,
 * never blocking). Rich text is deliberately base-only — its typography and
 * fills live on spans, out of scope for node-level style transfer.
 */
export const NODE_STYLE_KEYS: Record<
	CanvasNodeKind,
	readonly CanvasNodeStyleKey[]
> = {
	group: BASE_KEYS,
	frame: [...BASE_KEYS, "fill", "radius", "cornerRadii"],
	rect: [
		...BASE_KEYS,
		"fill",
		...STROKE_KEYS,
		"radius",
		"cornerRadii",
		"effects",
	],
	ellipse: [...BASE_KEYS, "fill", ...STROKE_KEYS, "effects"],
	polygon: [...BASE_KEYS, "fill", ...STROKE_KEYS, "effects"],
	star: [...BASE_KEYS, "fill", ...STROKE_KEYS, "effects"],
	line: [...BASE_KEYS, ...STROKE_KEYS, ...ARROW_KEYS],
	path: [...BASE_KEYS, "fill", ...STROKE_KEYS, ...ARROW_KEYS, "effects"],
	text: [...BASE_KEYS, "fill", ...TEXT_KEYS, "effects"],
	"rich-text": BASE_KEYS,
	image: [...BASE_KEYS, "adjustments"],
	svg: BASE_KEYS,
	"ai-placeholder": BASE_KEYS,
	video: BASE_KEYS,
	audio: BASE_KEYS,
};

/** A frame's "fill" is stored under `background`; every other kind uses `fill`. */
function targetKeyFor(kind: CanvasNodeKind, key: CanvasNodeStyleKey): string {
	return kind === "frame" && key === "fill" ? "background" : key;
}

/**
 * FR-120: extract the portable style of a node — only keys its kind owns per
 * the matrix, only values actually present. A frame's `background` extracts
 * as `fill`; a legacy `shadow` extracts as its `effects` equivalent.
 */
export function extractNodeStyle(node: CanvasNode): CanvasNodeStyle {
	const keys = NODE_STYLE_KEYS[node.type];
	const record = node as unknown as Record<string, unknown>;
	const style: Record<string, unknown> = {};
	for (const key of keys) {
		if (key === "effects") {
			const effects = resolveNodeEffects(
				node as { effects?: CanvasEffect[]; shadow?: CanvasShadow },
			);
			if (effects.length > 0) style.effects = [...effects];
			continue;
		}
		const value = record[targetKeyFor(node.type, key)];
		if (value !== undefined) style[key] = value;
	}
	return style as CanvasNodeStyle;
}

export interface StylePatchResult {
	/** node.update-shaped patch for the target node (empty = nothing to apply). */
	patch: Record<string, unknown>;
	/** Style keys the target kind accepted. */
	applied: CanvasNodeStyleKey[];
	/** Style keys the target kind cannot receive (FR-121: reported, not blocking). */
	ignored: CanvasNodeStyleKey[];
}

/**
 * FR-121: intersect a style payload with the target's compatible keys. Pure —
 * the `node.applyStyle` command and any pre-commit UI reporting both call
 * this, so what the command applies and what the UI reports never diverge.
 * Applying `effects` also clears a legacy `shadow` so the target has one
 * source of truth afterwards.
 */
export function computeStylePatch(
	node: CanvasNode,
	style: CanvasNodeStyle,
): StylePatchResult {
	const allowed = new Set(NODE_STYLE_KEYS[node.type]);
	const patch: Record<string, unknown> = {};
	const applied: CanvasNodeStyleKey[] = [];
	const ignored: CanvasNodeStyleKey[] = [];
	for (const [key, value] of Object.entries(style) as Array<
		[CanvasNodeStyleKey, unknown]
	>) {
		if (value === undefined) continue;
		if (!allowed.has(key)) {
			ignored.push(key);
			continue;
		}
		patch[targetKeyFor(node.type, key)] = value;
		if (key === "effects") patch.shadow = undefined;
		applied.push(key);
	}
	return { patch, applied, ignored };
}
