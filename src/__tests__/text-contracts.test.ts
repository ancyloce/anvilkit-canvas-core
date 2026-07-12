import { describe, expect, it } from "vitest";
import {
	type RichTextStyleDefaults,
	resolveSpanStyle,
} from "../text-contracts.js";

const DEFAULTS: RichTextStyleDefaults = {
	fontFamily: "Inter",
	fontSize: 16,
	fontWeight: "400",
	italic: false,
	underline: false,
	letterSpacing: 0,
	textTransform: "none",
	fill: "#000000",
	lineHeight: 1.4,
	align: "left",
};

describe("resolveSpanStyle", () => {
	it("falls back to the host defaults for every unset field", () => {
		expect(resolveSpanStyle({ text: "hi" }, DEFAULTS)).toEqual({
			fontFamily: "Inter",
			fontSize: 16,
			fontWeight: "400",
			italic: false,
			underline: false,
			letterSpacing: 0,
			textTransform: "none",
			fill: "#000000",
		});
	});

	it("lets the span override every field", () => {
		const resolved = resolveSpanStyle(
			{
				text: "hi",
				fontFamily: "Georgia",
				fontSize: 24,
				fontWeight: "700",
				italic: true,
				underline: true,
				letterSpacing: -0.5,
				textTransform: "uppercase",
				fill: "#ff0000",
			},
			DEFAULTS,
		);
		expect(resolved).toEqual({
			fontFamily: "Georgia",
			fontSize: 24,
			fontWeight: "700",
			italic: true,
			underline: true,
			letterSpacing: -0.5,
			textTransform: "uppercase",
			fill: "#ff0000",
		});
	});

	// `??` (not `||`), so a span that deliberately sets a falsy value keeps it
	// instead of silently snapping back to the default.
	it("keeps falsy overrides rather than treating them as unset", () => {
		const loud: RichTextStyleDefaults = {
			...DEFAULTS,
			italic: true,
			underline: true,
			letterSpacing: 4,
			fontSize: 32,
		};
		const resolved = resolveSpanStyle(
			{ text: "hi", italic: false, underline: false, letterSpacing: 0 },
			loud,
		);
		expect(resolved.italic).toBe(false);
		expect(resolved.underline).toBe(false);
		expect(resolved.letterSpacing).toBe(0);
		// Untouched fields still inherit.
		expect(resolved.fontSize).toBe(32);
	});

	it("does not mutate the span or the defaults", () => {
		const span = { text: "hi", fontSize: 20 };
		const defaults = { ...DEFAULTS };
		resolveSpanStyle(span, defaults);
		expect(span).toEqual({ text: "hi", fontSize: 20 });
		expect(defaults).toEqual(DEFAULTS);
	});
});
