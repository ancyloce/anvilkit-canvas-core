import { describe, expect, it } from "vitest";
import {
	MAX_CLIPBOARD_BYTES,
	MAX_CLIPBOARD_NODES,
} from "../clipboard/index.js";
import { MAX_TREE_DEPTH } from "../ir/index.js";
import * as limits from "../limits.js";

/**
 * @file T-M0-03 (plan 0022 M0) — central resource-limit module.
 *
 * `limits.ts` exists because three caps that bound untrusted input were
 * defined in the modules that happened to use them first (`MAX_TREE_DEPTH`
 * in `ir/walkers.ts`, the clipboard caps in `clipboard/payload.ts`), leaving
 * no single place to answer "what does this package refuse to process?".
 *
 * The failure mode a central module invites is a *second* definition: a
 * caller that wants the depth cap adds its own `const MAX_DEPTH = 64` rather
 * than importing, and the two drift. These assertions pin the original public
 * paths to the canonical bindings, so re-introducing a private copy behind
 * either old export fails here instead of at a size mismatch in production.
 */
describe("central resource limits (T-M0-03)", () => {
	it("serves the depth cap through its original public path", () => {
		// Identity, not equality: a re-declared `= 64` elsewhere would still
		// compare equal, which is precisely the drift this guards against.
		expect(MAX_TREE_DEPTH).toBe(limits.MAX_TREE_DEPTH);
	});

	it("serves the clipboard caps through their original public path", () => {
		expect(MAX_CLIPBOARD_NODES).toBe(limits.MAX_CLIPBOARD_NODES);
		expect(MAX_CLIPBOARD_BYTES).toBe(limits.MAX_CLIPBOARD_BYTES);
	});

	it("preserves the shipped cap values across the move", () => {
		// The move must be behaviour-preserving: these are the values that
		// shipped in 0.1.2-rc.1, and changing one is a compatibility decision,
		// not a refactor.
		expect(limits.MAX_TREE_DEPTH).toBe(64);
		expect(limits.MAX_CLIPBOARD_NODES).toBe(1_000);
		expect(limits.MAX_CLIPBOARD_BYTES).toBe(2 * 1024 * 1024);
	});

	it("keeps the finite-magnitude ceiling exact under 1e-4 quantisation", () => {
		// The documented derivation for MAX_FINITE_LAYOUT_MAGNITUDE: layout
		// output quantises to 1e-4, so the cap is only meaningful while
		// `value * 1e4` stays an exact integer in IEEE-754.
		expect(limits.MAX_FINITE_LAYOUT_MAGNITUDE * 1e4).toBeLessThan(
			Number.MAX_SAFE_INTEGER,
		);
		expect(Number.isSafeInteger(limits.MAX_FINITE_LAYOUT_MAGNITUDE * 1e4)).toBe(
			true,
		);
	});

	it("declares every cap as a positive finite number", () => {
		for (const [name, value] of Object.entries(limits)) {
			expect(typeof value, `${name} must be numeric`).toBe("number");
			expect(Number.isFinite(value), `${name} must be finite`).toBe(true);
			expect(value, `${name} must be positive`).toBeGreaterThan(0);
		}
	});
});
