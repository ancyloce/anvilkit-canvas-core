import { describe, expect, it } from "vitest";
import type { CanvasAnimation } from "../types.js";
import { CanvasAnimationSchema } from "../validators.js";

describe("CanvasAnimationSchema", () => {
	it("validates each of the seven animation kinds", () => {
		const animations: CanvasAnimation[] = [
			{ kind: "fade", duration: 0.5 },
			{ kind: "slide", duration: 0.5, direction: "up" },
			{ kind: "scale", duration: 0.5 },
			{ kind: "rotate", duration: 0.5, from: -90 },
			{ kind: "pop", duration: 0.3, overshoot: 1.1 },
			{ kind: "typewriter", duration: 2, charsPerSecond: 20 },
			{ kind: "motion-path", duration: 3, path: "M0,0 L100,100" },
		];
		for (const animation of animations) {
			expect(CanvasAnimationSchema.parse(animation)).toEqual(animation);
		}
	});

	it("accepts the shared timing fields (delay/easing) on any kind", () => {
		const animation: CanvasAnimation = {
			kind: "fade",
			delay: 1.5,
			duration: 0.5,
			easing: "ease-in-out",
			from: 0,
		};
		expect(CanvasAnimationSchema.parse(animation)).toEqual(animation);
	});

	it("rejects a missing required duration", () => {
		expect(() => CanvasAnimationSchema.parse({ kind: "fade" })).toThrow();
	});

	it("rejects an unknown kind", () => {
		expect(() =>
			CanvasAnimationSchema.parse({ kind: "bounce", duration: 1 }),
		).toThrow();
	});

	it("rejects a negative duration", () => {
		expect(() =>
			CanvasAnimationSchema.parse({ kind: "fade", duration: -1 }),
		).toThrow();
	});

	it("requires slide's direction and motion-path's path", () => {
		expect(() =>
			CanvasAnimationSchema.parse({ kind: "slide", duration: 1 }),
		).toThrow();
		expect(() =>
			CanvasAnimationSchema.parse({ kind: "motion-path", duration: 1 }),
		).toThrow();
	});
});
