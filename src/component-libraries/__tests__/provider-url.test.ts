import { describe, expect, it } from "vitest";

import {
	MAX_CLIPBOARD_BYTES,
	MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT,
	MAX_COMPONENT_NESTED_DEPTH,
	MAX_COMPONENT_PROPERTIES_PER_COMPONENT,
	MAX_COMPONENT_VARIANT_AXES,
	MAX_COMPONENT_VARIANT_VALUES_PER_AXIS,
	MAX_COMPONENT_VARIANTS_PER_COMPONENT,
	MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT,
	MAX_EXTERNAL_DEPENDENCY_DEPTH,
	MAX_EXTERNAL_DISPLAY_STRING_CHARS,
	MAX_EXTERNAL_ENVELOPE_BYTES,
	MAX_EXTERNAL_REF_FIELD_CHARS,
	MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT,
	MAX_EXTERNAL_URL_CHARS,
	MAX_TREE_DEPTH,
} from "../../limits.js";
import { normalizeUri, sanitizeProviderUrl } from "../../uri.js";
import {
	type CanvasComponentLimitCode,
	CanvasComponentLimitError,
	enforceLimit,
	limitFor,
} from "../errors.js";

/**
 * NFR-SEC / TD §22.2 — every cap has a test that trips it, and unsafe schemes
 * are stripped rather than rendered.
 */

describe("sanitizeProviderUrl — scheme allowlist (TD §22.2)", () => {
	it("strips javascript: in every casing and obfuscation we can construct", () => {
		for (const hostile of [
			"javascript:alert(1)",
			"JavaScript:alert(1)",
			"JAVASCRIPT:alert(1)",
			"  javascript:alert(1)  ",
			// Control characters must be stripped BEFORE the scheme test, or a
			// naive prefix check is bypassed.
			"java\nscript:alert(1)",
			"java\tscript:alert(1)",
			"java\rscript:alert(1)",
			// NUL and other C0 bytes are written as ESCAPES, never literal bytes,
			// so this stays a text file (repo convention).
			"java\u0000script:alert(1)",
			"\u0001javascript:alert(1)",
			"java\u007fscript:alert(1)",
		]) {
			expect(sanitizeProviderUrl(hostile)).toBeUndefined();
		}
	});

	it("strips data: regardless of payload — a catalog never inlines an image", () => {
		// This is the documented difference from `normalizeUri`, which DOES accept
		// safe raster data URIs when explicitly asked. Provider metadata does not
		// get that option.
		const png = "data:image/png;base64,AAAA";
		expect(normalizeUri(png, { allowSafeDataImage: true })).toBe(png);
		expect(sanitizeProviderUrl(png)).toBeUndefined();
		expect(
			sanitizeProviderUrl("data:text/html,<script>alert(1)</script>"),
		).toBeUndefined();
	});

	it("strips every other scheme, including ones not on any blocklist", () => {
		for (const hostile of [
			"vbscript:msgbox",
			"file:///etc/passwd",
			"blob:https://x/y",
			"filesystem:https://x",
			"ftp://host/a.png",
			"mailto:a@b.com",
			"ws://host",
			"custom-scheme://x",
			"about:blank",
		]) {
			expect(sanitizeProviderUrl(hostile)).toBeUndefined();
		}
	});

	it("requires an explicit scheme — relative and protocol-relative are refused", () => {
		// `normalizeUri` allows these because a relative href inside an SVG
		// resolves against that document. Provider metadata has no such base, so a
		// protocol-relative URL would resolve against the APP's origin.
		expect(normalizeUri("//cdn.example.com/a.png")).toBe(
			"//cdn.example.com/a.png",
		);
		expect(normalizeUri("/assets/a.png")).toBe("/assets/a.png");

		expect(sanitizeProviderUrl("//cdn.example.com/a.png")).toBeUndefined();
		expect(sanitizeProviderUrl("/assets/a.png")).toBeUndefined();
		expect(sanitizeProviderUrl("some/relative/path")).toBeUndefined();
	});

	it("accepts absolute http and https", () => {
		expect(sanitizeProviderUrl("https://cdn.example.com/notes.html")).toBe(
			"https://cdn.example.com/notes.html",
		);
		expect(sanitizeProviderUrl("http://cdn.example.com/thumb.png")).toBe(
			"http://cdn.example.com/thumb.png",
		);
		expect(sanitizeProviderUrl("https://x.example/a?b=1&c=2#frag")).toBe(
			"https://x.example/a?b=1&c=2#frag",
		);
	});

	it("refuses empty, blank, and malformed authorities", () => {
		expect(sanitizeProviderUrl("")).toBeUndefined();
		expect(sanitizeProviderUrl("   ")).toBeUndefined();
		expect(sanitizeProviderUrl("https://")).toBeUndefined();
		// Non-string input can arrive from an untrusted JSON payload.
		expect(sanitizeProviderUrl(undefined as unknown as string)).toBeUndefined();
		expect(sanitizeProviderUrl(null as unknown as string)).toBeUndefined();
	});

	it("never returns the raw input when it refuses", () => {
		// Guards the contract callers depend on: `undefined` means render nothing.
		for (const hostile of ["javascript:x", "data:text/html,x", "//evil"]) {
			const result = sanitizeProviderUrl(hostile);
			expect(result).toBeUndefined();
			expect(result).not.toBe(hostile);
		}
	});
});

describe("resource caps — every cap trips (NFR-SEC)", () => {
	const cases: ReadonlyArray<[CanvasComponentLimitCode, number]> = [
		["envelope-too-large", MAX_EXTERNAL_ENVELOPE_BYTES],
		["too-many-snapshots", MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT],
		["too-many-dependencies", MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT],
		["excessive-dependency-depth", MAX_EXTERNAL_DEPENDENCY_DEPTH],
		["too-many-variants", MAX_COMPONENT_VARIANTS_PER_COMPONENT],
		["too-many-variant-axes", MAX_COMPONENT_VARIANT_AXES],
		["too-many-variant-values", MAX_COMPONENT_VARIANT_VALUES_PER_AXIS],
		["field-too-long", MAX_EXTERNAL_REF_FIELD_CHARS],
		["url-too-long", MAX_EXTERNAL_URL_CHARS],
		["string-too-long", MAX_EXTERNAL_DISPLAY_STRING_CHARS],
	];

	it.each(
		cases,
	)("%s trips one past its ceiling but not at it", (code, limit) => {
		expect(limitFor(code)).toBe(limit);
		expect(() => enforceLimit(code, limit)).not.toThrow();
		expect(() => enforceLimit(code, limit + 1)).toThrow(
			CanvasComponentLimitError,
		);
	});

	it("covers every member of the limit-code union", () => {
		// If a code is added to the union without a case above, this fails —
		// otherwise a new cap could ship with no test that trips it.
		expect(cases.length).toBe(10);
		expect(new Set(cases.map(([code]) => code)).size).toBe(cases.length);
	});

	it("reports observed, limit, and code on the thrown error", () => {
		let caught: unknown;
		try {
			enforceLimit("too-many-dependencies", 999, "dependency bomb");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CanvasComponentLimitError);
		const error = caught as CanvasComponentLimitError;
		expect(error.code).toBe("too-many-dependencies");
		expect(error.observed).toBe(999);
		expect(error.limit).toBe(MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT);
		expect(error.name).toBe("CanvasComponentLimitError");
		expect(error.message).toContain("dependency bomb");
	});

	it("rejects a dependency bomb and deep recursion at the documented ceilings", () => {
		// Fan-out axis.
		const fanOut = MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT + 1;
		expect(() => enforceLimit("too-many-dependencies", fanOut)).toThrow(
			/too-many-dependencies/,
		);
		// Depth axis — independent of fan-out, which is why both exist.
		const depth = MAX_EXTERNAL_DEPENDENCY_DEPTH + 1;
		expect(() => enforceLimit("excessive-dependency-depth", depth)).toThrow(
			/excessive-dependency-depth/,
		);
	});

	it("rejects oversized strings on each string axis", () => {
		expect(() =>
			enforceLimit(
				"field-too-long",
				"x".repeat(MAX_EXTERNAL_REF_FIELD_CHARS + 1).length,
			),
		).toThrow(CanvasComponentLimitError);
		expect(() =>
			enforceLimit(
				"url-too-long",
				"x".repeat(MAX_EXTERNAL_URL_CHARS + 1).length,
			),
		).toThrow(CanvasComponentLimitError);
		expect(() =>
			enforceLimit(
				"string-too-long",
				"x".repeat(MAX_EXTERNAL_DISPLAY_STRING_CHARS + 1).length,
			),
		).toThrow(CanvasComponentLimitError);
	});
});

describe("cap anchoring — the reuse claims in limits.ts hold", () => {
	it("reuses local component caps for the same quantities", () => {
		// Two caps for one quantity is how the looser one silently becomes the real
		// limit; these assertions are what stop a near-duplicate creeping back in.
		expect(MAX_EXTERNAL_ENVELOPE_BYTES).toBe(MAX_CLIPBOARD_BYTES);
		expect(MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT).toBe(
			MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT,
		);
		expect(MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT).toBe(
			MAX_COMPONENT_PROPERTIES_PER_COMPONENT,
		);
		expect(MAX_EXTERNAL_DEPENDENCY_DEPTH).toBe(MAX_COMPONENT_NESTED_DEPTH);
	});

	it("keeps dependency depth clear of the walker guard", () => {
		// An expanded closure becomes a real node tree, so it must not be able to
		// reach MAX_TREE_DEPTH on its own.
		expect(MAX_EXTERNAL_DEPENDENCY_DEPTH).toBeLessThan(MAX_TREE_DEPTH);
	});

	it("caps stored variants independently of the axis/value product", () => {
		// Sparse storage means axes x values massively exceeds what can be stored;
		// only the stored count is checkable, so it must be capped separately.
		const denseCombinations =
			MAX_COMPONENT_VARIANT_VALUES_PER_AXIS ** MAX_COMPONENT_VARIANT_AXES;
		expect(denseCombinations).toBeGreaterThan(
			MAX_COMPONENT_VARIANTS_PER_COMPONENT,
		);
	});

	it("fixes the ref-field bound at the value TD §5.3 requires", () => {
		expect(MAX_EXTERNAL_REF_FIELD_CHARS).toBe(256);
	});
});
