import type {
	CanvasDropShadowEffect,
	CanvasEffect,
	CanvasShadow,
} from "./types.js";

/**
 * The ONE effect resolver (C-03, §9.4) — every consumer (the editor's Konva
 * renderer, the SVG serializer, the inspector) resolves a node's effects
 * through this so canvas, export, and UI can never disagree.
 *
 * Precedence: a present `effects` array wins outright — including an EMPTY
 * one, which means "explicitly no effects" (that is how an edit removes a
 * legacy shadow without deleting history). Only when `effects` is absent does
 * the legacy `shadow` field apply, interpreted as a single drop-shadow with
 * no spread. The legacy field is never mutated here; writes that upgrade a
 * node to the new model are the editor's job.
 */
export function resolveNodeEffects(node: {
	effects?: CanvasEffect[];
	shadow?: CanvasShadow;
}): readonly CanvasEffect[] {
	if (node.effects !== undefined) return node.effects;
	if (node.shadow) return [shadowToDropShadowEffect(node.shadow)];
	return [];
}

/** Lift a legacy `CanvasShadow` into the effect model (spread = absent). */
export function shadowToDropShadowEffect(
	shadow: CanvasShadow,
): CanvasDropShadowEffect {
	return {
		type: "drop-shadow",
		color: shadow.color,
		blur: shadow.blur,
		offsetX: shadow.offsetX,
		offsetY: shadow.offsetY,
		...(shadow.opacity !== undefined ? { opacity: shadow.opacity } : {}),
	};
}

/** The first drop shadow in a resolved effect list (what a one-shadow UI edits). */
export function firstDropShadow(
	effects: readonly CanvasEffect[],
): CanvasDropShadowEffect | undefined {
	return effects.find(
		(e): e is CanvasDropShadowEffect => e.type === "drop-shadow",
	);
}
