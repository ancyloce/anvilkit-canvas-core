import { describe, expect, it } from "vitest";
import { nowIso, resolveNow } from "../clock.js";

describe("clock", () => {
	it("nowIso returns a parseable ISO-8601 timestamp", () => {
		const iso = nowIso();
		expect(typeof iso).toBe("string");
		expect(Number.isNaN(Date.parse(iso))).toBe(false);
	});

	it("resolveNow falls back to nowIso when no clock is injected", () => {
		const now = resolveNow(undefined);
		expect(Number.isNaN(Date.parse(now()))).toBe(false);
	});

	it("resolveNow passes an injected clock through verbatim", () => {
		const fixed = () => "2026-01-01T00:00:00.000Z";
		expect(resolveNow(fixed)).toBe(fixed);
		expect(resolveNow(fixed)()).toBe("2026-01-01T00:00:00.000Z");
	});
});
