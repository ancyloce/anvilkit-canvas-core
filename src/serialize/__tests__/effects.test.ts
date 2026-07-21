import { describe, expect, it } from "vitest";
import { createCanvasIR, createPage } from "../../ir/builders.js";
import {
	firstDropShadow,
	resolveNodeEffects,
	shadowToDropShadowEffect,
} from "../../ir/effects.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasEffect, CanvasIR, CanvasNode } from "../../ir/types.js";
import {
	CanvasEffectSchema,
	CanvasRectNodeSchema,
} from "../../ir/validators.js";
import { serializePageToSvg } from "../svg.js";

const baseRect = {
	id: "r1",
	type: "rect",
	transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
	bounds: { width: 10, height: 10 },
	zIndex: 0,
	fill: "#ff0000",
};

const LEGACY_SHADOW = { color: "#000000", blur: 4, offsetX: 2, offsetY: 2 };

function irWith(node: Record<string, unknown>): CanvasIR {
	const page = createPage({ id: "p1" });
	const ir = createCanvasIR({ id: "ir", title: "t", pages: [page] });
	return insertNode(ir, { parentId: page.root.id, node: node as never });
}

describe("resolveNodeEffects (C-03, §9.4 precedence)", () => {
	it("falls back to the legacy shadow field when effects is absent", () => {
		const node = { shadow: LEGACY_SHADOW } as Partial<CanvasNode>;
		expect(resolveNodeEffects(node as never)).toEqual([
			{ type: "drop-shadow", ...LEGACY_SHADOW },
		]);
	});

	it("a present effects array wins over shadow — including an EMPTY one", () => {
		const effects: CanvasEffect[] = [{ type: "blur", radius: 6 }];
		expect(resolveNodeEffects({ effects, shadow: LEGACY_SHADOW })).toEqual(
			effects,
		);
		expect(resolveNodeEffects({ effects: [], shadow: LEGACY_SHADOW })).toEqual(
			[],
		);
	});

	it("no shadow and no effects resolves to none", () => {
		expect(resolveNodeEffects({})).toEqual([]);
	});

	it("shadowToDropShadowEffect keeps opacity only when present", () => {
		expect(shadowToDropShadowEffect(LEGACY_SHADOW)).not.toHaveProperty(
			"opacity",
		);
		expect(
			shadowToDropShadowEffect({ ...LEGACY_SHADOW, opacity: 0.5 }).opacity,
		).toBe(0.5);
	});

	it("firstDropShadow skips leading non-shadow effects", () => {
		const drop = { type: "drop-shadow" as const, ...LEGACY_SHADOW, spread: 2 };
		expect(firstDropShadow([{ type: "blur", radius: 1 }, drop])).toEqual(drop);
		expect(firstDropShadow([{ type: "blur", radius: 1 }])).toBeUndefined();
	});
});

describe("CanvasEffect schema", () => {
	it("accepts drop-shadow with spread and blur effects on a rect", () => {
		const parsed = CanvasRectNodeSchema.parse({
			...baseRect,
			effects: [
				{ type: "drop-shadow", ...LEGACY_SHADOW, spread: 3 },
				{ type: "blur", radius: 5 },
			],
		}) as { effects: unknown };
		expect(parsed.effects).toHaveLength(2);
	});

	it("rejects an unknown effect type and a negative spread", () => {
		expect(
			CanvasEffectSchema.safeParse({ type: "glow", radius: 3 }).success,
		).toBe(false);
		expect(
			CanvasEffectSchema.safeParse({
				type: "drop-shadow",
				...LEGACY_SHADOW,
				spread: -1,
			}).success,
		).toBe(false);
	});
});

describe("SVG serialization of effects (C-03)", () => {
	it("effects=[one spreadless drop-shadow] emits the LEGACY feDropShadow markup", async () => {
		const viaLegacy = await serializePageToSvg(
			irWith({ ...baseRect, shadow: LEGACY_SHADOW }),
			"p1",
		);
		const viaEffects = await serializePageToSvg(
			irWith({
				...baseRect,
				effects: [{ type: "drop-shadow", ...LEGACY_SHADOW }],
			}),
			"p1",
		);
		expect(viaEffects.svg).toBe(viaLegacy.svg);
		expect(viaEffects.svg).toContain("<feDropShadow");
		expect(viaEffects.svg).toContain('filter="url(#shadow-r1)"');
	});

	it("spread emits a dilate → blur → offset → flood/composite chain", async () => {
		const { svg } = await serializePageToSvg(
			irWith({
				...baseRect,
				effects: [
					{ type: "drop-shadow", ...LEGACY_SHADOW, spread: 3, opacity: 0.5 },
				],
			}),
			"p1",
		);
		expect(svg).toContain('filter="url(#effects-r1)"');
		expect(svg).toContain(
			'<feMorphology in="SourceAlpha" operator="dilate" radius="3"',
		);
		expect(svg).toContain('<feGaussianBlur in="sp0" stdDeviation="2"');
		expect(svg).toContain('<feOffset in="bl0" dx="2" dy="2"');
		expect(svg).toContain('flood-opacity="0.5"');
		expect(svg).toContain('<feMergeNode in="sh0" />');
		expect(svg).toContain('<feMergeNode in="SourceGraphic" />');
	});

	it("multiple shadows merge in order under the source", async () => {
		const { svg } = await serializePageToSvg(
			irWith({
				...baseRect,
				effects: [
					{ type: "drop-shadow", ...LEGACY_SHADOW },
					{ type: "drop-shadow", ...LEGACY_SHADOW, offsetX: -2, offsetY: -2 },
				],
			}),
			"p1",
		);
		expect(svg).toContain('<feMergeNode in="sh0" />');
		expect(svg).toContain('<feMergeNode in="sh1" />');
	});

	it("a blur effect emits feGaussianBlur; blur-only filters the source directly", async () => {
		const { svg } = await serializePageToSvg(
			irWith({ ...baseRect, effects: [{ type: "blur", radius: 8 }] }),
			"p1",
		);
		expect(svg).toContain('filter="url(#effects-r1)"');
		expect(svg).toContain('<feGaussianBlur stdDeviation="4" />');
		expect(svg).not.toContain("<feMerge>");
	});

	it("combines multiple blur effects by quadrature, not by summing radii (C-18)", async () => {
		// sqrt(6² + 8²) = sqrt(100) = 10 → stdDeviation 5. A naive sum would
		// give radius 14 → stdDeviation 7, overstating the combined blur.
		const { svg } = await serializePageToSvg(
			irWith({
				...baseRect,
				effects: [
					{ type: "blur", radius: 6 },
					{ type: "blur", radius: 8 },
				],
			}),
			"p1",
		);
		expect(svg).toContain('<feGaussianBlur stdDeviation="5" />');
	});

	it("effects: [] suppresses the legacy shadow (explicit removal)", async () => {
		const { svg } = await serializePageToSvg(
			irWith({ ...baseRect, shadow: LEGACY_SHADOW, effects: [] }),
			"p1",
		);
		expect(svg).not.toContain("filter=");
	});
});
