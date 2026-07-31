import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
	canonicalizeComponentPayload,
	canonicalizeComponentPayloadToString,
} from "../canonicalize.js";
import { CanvasCanonicalizationError } from "../errors.js";

/**
 * RFC 8785 goldens (plan 0021 T-006, GOLD).
 *
 * The fixture file is **hand-authored**, not generated from this implementation:
 * its `expected` strings were written from the RFC's rules so a bug here shows up
 * as a mismatch rather than being baked in. `why` on each fixture records what it
 * discriminates.
 *
 * These goldens are also what the cross-runtime check
 * (`scripts/check-canonical-cross-runtime.mjs`) compares against inside a real
 * browser engine, which is the part that actually guards risk R-3 — NFC is
 * ICU-backed and is the one step that could plausibly differ between runtimes.
 */

const FIXTURES_URL = new URL(
	"./fixtures/canonical/goldens.json",
	import.meta.url,
);

interface Golden {
	readonly name: string;
	readonly why: string;
	readonly input: unknown;
	readonly expected: string;
}

const goldens: readonly Golden[] = JSON.parse(
	readFileSync(fileURLToPath(FIXTURES_URL), "utf8"),
);

describe("canonicalizeComponentPayload — committed goldens", () => {
	it("loaded a non-empty fixture set", () => {
		// An empty fixture file would make every assertion below vacuously pass.
		expect(goldens.length).toBeGreaterThanOrEqual(15);
	});

	it.each(
		goldens.map((golden) => [golden.name, golden] as const),
	)("%s", (_name, golden) => {
		expect(canonicalizeComponentPayloadToString(golden.input)).toBe(
			golden.expected,
		);
	});

	it("byte output is exactly UTF-8 of the canonical string", () => {
		const encoder = new TextEncoder();
		for (const golden of goldens) {
			expect(canonicalizeComponentPayload(golden.input)).toEqual(
				encoder.encode(golden.expected),
			);
		}
	});

	it("returns a Uint8Array", () => {
		expect(canonicalizeComponentPayload({ a: 1 })).toBeInstanceOf(Uint8Array);
	});
});

describe("RFC 8785 properties asserted independently of the goldens", () => {
	it("sorts keys by UTF-16 code unit, not by code point", () => {
		// The load-bearing distinction: U+10000 is stored as the surrogate pair
		// D800 DC00, and 0xD800 < 0xFFFD, so the astral key must come FIRST.
		// A code-point sort would put it last.
		const astral = String.fromCodePoint(0x10000);
		const replacement = "�";
		const out = canonicalizeComponentPayloadToString({
			[replacement]: 1,
			[astral]: 2,
		});
		expect(out.indexOf(astral)).toBeLessThan(out.indexOf(replacement));
	});

	it("sorts keys lexicographically, never numerically", () => {
		const out = canonicalizeComponentPayloadToString({ 2: "b", 10: "a" });
		expect(out).toBe('{"10":"a","2":"b"}');
	});

	it("is insensitive to input key order (property)", () => {
		// The core JCS guarantee: the same logical payload always hashes the same,
		// whatever order the parser or the network happened to deliver keys in.
		const entries = fc.array(
			fc.tuple(
				fc.string({ minLength: 1, maxLength: 8 }),
				fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.boolean()),
			),
			{ minLength: 1, maxLength: 12 },
		);

		fc.assert(
			fc.property(entries, (pairs) => {
				const object = Object.fromEntries(pairs);
				const shuffled = Object.fromEntries(
					[...Object.entries(object)].reverse(),
				);
				expect(canonicalizeComponentPayloadToString(shuffled)).toBe(
					canonicalizeComponentPayloadToString(object),
				);
			}),
			{ numRuns: 300 },
		);
	});

	it("is idempotent — canonicalizing a re-parsed payload is stable", () => {
		fc.assert(
			fc.property(
				fc.dictionary(
					fc.string({ minLength: 1, maxLength: 6 }),
					fc.oneof(fc.integer(), fc.string({ maxLength: 6 }), fc.boolean()),
					{ maxKeys: 8 },
				),
				(payload) => {
					const once = canonicalizeComponentPayloadToString(payload);
					const twice = canonicalizeComponentPayloadToString(JSON.parse(once));
					expect(twice).toBe(once);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("preserves array order under permutation of a surrounding object", () => {
		const a = canonicalizeComponentPayloadToString({ x: [1, 2, 3], y: 0 });
		const b = canonicalizeComponentPayloadToString({ y: 0, x: [1, 2, 3] });
		expect(a).toBe(b);
		expect(a).toContain("[1,2,3]");
		// ...and a genuinely different array order is a DIFFERENT payload.
		expect(
			canonicalizeComponentPayloadToString({ x: [3, 2, 1], y: 0 }),
		).not.toBe(a);
	});

	it("normalizes to NFC so decomposed and precomposed forms agree", () => {
		const precomposed = canonicalizeComponentPayloadToString({
			é: "é",
		});
		const decomposed = canonicalizeComponentPayloadToString({
			é: "é",
		});
		expect(decomposed).toBe(precomposed);
	});

	it("treats -0 and +0 as the same preimage", () => {
		expect(canonicalizeComponentPayloadToString({ a: -0 })).toBe(
			canonicalizeComponentPayloadToString({ a: 0 }),
		);
	});

	it("omits properties whose value is undefined", () => {
		// Load-bearing: an optional envelope field left explicitly `undefined` must
		// hash identically to one that is absent, or the digest would depend on how
		// the parser happened to construct the object.
		expect(canonicalizeComponentPayloadToString({ a: 1, b: undefined })).toBe(
			canonicalizeComponentPayloadToString({ a: 1 }),
		);
	});

	it("ignores symbol keys, which JSON cannot represent", () => {
		const payload = { a: 1, [Symbol("hidden")]: 2 };
		expect(canonicalizeComponentPayloadToString(payload)).toBe('{"a":1}');
	});
});

describe("canonicalization refuses inputs with no deterministic form", () => {
	it("rejects non-finite numbers rather than coercing them to null", () => {
		for (const value of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			// JSON.stringify would emit `null` for each of these, collapsing three
			// distinct payloads onto one digest.
			expect(JSON.stringify({ a: value })).toBe('{"a":null}');
			let caught: unknown;
			try {
				canonicalizeComponentPayload({ a: value });
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(CanvasCanonicalizationError);
			expect((caught as CanvasCanonicalizationError).code).toBe(
				"non-finite-number",
			);
		}
	});

	it("rejects non-finite numbers at the top level and inside arrays", () => {
		expect(() => canonicalizeComponentPayload(Number.NaN)).toThrow(
			CanvasCanonicalizationError,
		);
		expect(() => canonicalizeComponentPayload([1, Number.NaN])).toThrow(
			CanvasCanonicalizationError,
		);
	});

	it("rejects cycles", () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		let caught: unknown;
		try {
			canonicalizeComponentPayload(cyclic);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CanvasCanonicalizationError);
		expect((caught as CanvasCanonicalizationError).code).toBe(
			"cyclic-reference",
		);
	});

	it("accepts the same object twice when it is not a cycle (diamond)", () => {
		const shared = { v: 1 };
		expect(canonicalizeComponentPayloadToString({ a: shared, b: shared })).toBe(
			'{"a":{"v":1},"b":{"v":1}}',
		);
	});

	it("rejects excessive depth", () => {
		let deep: unknown = 1;
		for (let i = 0; i < 200; i += 1) deep = { n: deep };
		let caught: unknown;
		try {
			canonicalizeComponentPayload(deep);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CanvasCanonicalizationError);
		expect((caught as CanvasCanonicalizationError).code).toBe("depth-exceeded");
	});

	it("rejects types JSON cannot express", () => {
		const cases: ReadonlyArray<unknown> = [
			undefined,
			1n,
			Symbol("x"),
			() => 1,
			new Date(0),
			new Map(),
			new Set(),
			/re/,
			new (class Custom {
				x = 1;
			})(),
		];
		for (const value of cases) {
			let caught: unknown;
			try {
				canonicalizeComponentPayload(value);
			} catch (error) {
				caught = error;
			}
			expect(caught, `should reject ${String(value)}`).toBeInstanceOf(
				CanvasCanonicalizationError,
			);
		}
	});

	it("refuses objects carrying toJSON — the preimage must not be payload-controlled", () => {
		const hostile = { a: 1, toJSON: () => ({ a: 2 }) };
		let caught: unknown;
		try {
			canonicalizeComponentPayload(hostile);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CanvasCanonicalizationError);
		expect((caught as CanvasCanonicalizationError).code).toBe(
			"unsupported-type",
		);
	});

	it("rejects array holes", () => {
		// eslint-disable-next-line no-sparse-arrays
		const sparse = [1, undefined, 3];
		expect(() => canonicalizeComponentPayload(sparse)).toThrow(
			CanvasCanonicalizationError,
		);
	});

	it("rejects keys that collide after NFC normalization", () => {
		const payload = { é: 1, é: 2 };
		// Both keys normalize to U+00E9, so the payload has no unambiguous form.
		let caught: unknown;
		try {
			canonicalizeComponentPayload(payload);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CanvasCanonicalizationError);
		expect((caught as CanvasCanonicalizationError).code).toBe(
			"duplicate-key-after-normalization",
		);
	});

	it("accepts a null-prototype object", () => {
		const bare = Object.create(null) as Record<string, unknown>;
		bare.a = 1;
		expect(canonicalizeComponentPayloadToString(bare)).toBe('{"a":1}');
	});
});
