import { describe, expect, it } from "vitest";
import {
	hasDrawablePathGeometry,
	isValidPathD,
	scalePathData,
} from "../path-data.js";

/**
 * @file The rank-0 path-`d` primitives.
 *
 * These three answer three DIFFERENT questions about the same string, and the
 * whole reason this module exists is that consumers used to conflate them:
 * `isValidPathD` is a sanitizer ("safe to write into an attribute"),
 * `hasDrawablePathGeometry` is a geometry check ("draws anything at all"), and
 * `scalePathData` is a rewrite. Defect D-1 was one consumer applying the first
 * where it needed the second.
 */

describe("isValidPathD — the character allowlist", () => {
	it("accepts real path data, including scientific notation and signs", () => {
		expect(isValidPathD("M0 0 L10 10 C1 1 2 2 3 3 Z")).toBe(true);
		expect(isValidPathD("M1.5e2 -3 L+4,5")).toBe(true);
	});

	it("rejects anything that could break out of an attribute", () => {
		expect(isValidPathD('M0 0"/><script>alert(1)</script>')).toBe(false);
		expect(isValidPathD("M0 0 fill=url(#x)")).toBe(false);
	});

	it("says NOTHING about whether the path draws — that is the other question", () => {
		// The exact input D-1 turned on: safe to write, draws nothing.
		expect(isValidPathD("Z")).toBe(true);
		expect(hasDrawablePathGeometry("Z")).toBe(false);
	});
});

describe("hasDrawablePathGeometry", () => {
	it("accepts data that contributes at least one coordinate", () => {
		for (const d of [
			"M0 0",
			"M0 0 L10 10 Z",
			"M 10 10 h 20 v 20 h -20 z",
			"M1.5e2 -3 L+4,5",
			"M0 0 C1 1 2 2 3 3",
			"M0 0 A5 5 0 0 1 10 10",
			// Implicit repetition: `M x y x y` is a moveto then a lineto.
			"M0 0 10 10 20 20",
		]) {
			expect(hasDrawablePathGeometry(d), d).toBe(true);
		}
	});

	it("rejects data that describes no region", () => {
		for (const d of [
			"", // empty
			"   ", // whitespace only
			"Z", // close with nothing to close — D-1's input
			"z",
			"M", // a command with no coordinates
			"garbage", // unparseable; note it contains `a`, an arc command
			"L", //
			"M0 0 L10", // an odd argument count is malformed, not "close enough"
			"5 5 L10 10", // numbers before any command
			"Z 5 5", // arguments after a zero-arity command
		]) {
			expect(hasDrawablePathGeometry(d), JSON.stringify(d)).toBe(false);
		}
	});

	it("is total over non-strings", () => {
		expect(hasDrawablePathGeometry(undefined as unknown as string)).toBe(false);
		expect(hasDrawablePathGeometry(42 as unknown as string)).toBe(false);
	});
});

describe("scalePathData", () => {
	it("scales absolute coordinates about the origin", () => {
		// The picker's diamond on a 200x200 frame, resized to 400x400.
		expect(scalePathData("M 100 0 L 200 100 L 100 200 L 0 100 Z", 2, 2)).toBe(
			"M 200 0 L 400 200 L 200 400 L 0 200 Z",
		);
	});

	it("scales each axis independently", () => {
		expect(scalePathData("M 0 0 L 10 10 Z", 3, 0.5)).toBe("M 0 0 L 30 5 Z");
	});

	it("scales relative deltas exactly like absolute coordinates", () => {
		// Scaling about the origin is linear, which is why `h`/`v`/lowercase
		// commands need no special case — only the right AXIS.
		expect(scalePathData("m 10 10 h 20 v 40 z", 2, 3)).toBe(
			"m 20 30 h 40 v 120 z",
		);
	});

	it("scales an arc's radii and endpoint but never its rotation or flags", () => {
		// rx ry rot large-arc sweep x y  →  rx*sx ry*sy rot large-arc sweep x*sx y*sy
		expect(scalePathData("M0 0 A 5 10 45 1 0 20 30", 2, 2)).toBe(
			"M 0 0 A 10 20 45 1 0 40 60",
		);
	});

	it("returns the input UNCHANGED rather than half-rewriting something it cannot parse", () => {
		// A half-scaled path is a mask nobody authored, so refusing is the only
		// safe failure.
		for (const d of ["garbage", "M0 0 L10", "M", "5 5 L10 10"]) {
			expect(scalePathData(d, 2, 2), d).toBe(d);
		}
	});

	it("returns the input unchanged for a no-op or degenerate scale", () => {
		const d = "M 0 0 L 10 10 Z";
		expect(scalePathData(d, 1, 1)).toBe(d);
		expect(scalePathData(d, 0, 2)).toBe(d);
		expect(scalePathData(d, -1, 2)).toBe(d);
		expect(scalePathData(d, Number.NaN, 2)).toBe(d);
		expect(scalePathData(d, Number.POSITIVE_INFINITY, 2)).toBe(d);
	});

	it("keeps its output inside the allowlist, so a scaled path is still emittable", () => {
		const scaled = scalePathData("M 100 0 L 200 100 Z", 1 / 3, 1 / 7);
		expect(isValidPathD(scaled)).toBe(true);
		expect(hasDrawablePathGeometry(scaled)).toBe(true);
		// Float noise is trimmed rather than serialised in full.
		expect(scaled).not.toMatch(/\d{10}/);
	});
});
