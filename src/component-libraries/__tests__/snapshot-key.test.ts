import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_EXTERNAL_REF_FIELD_CHARS } from "../../limits.js";
import { CanvasSnapshotKeyError } from "../errors.js";
import {
	CanvasComponentSourceRefSchema,
	CanvasExternalComponentRefSchema,
} from "../schema.js";
import {
	isSnapshotKey,
	parseSnapshotKey,
	SnapshotKeySchema,
	snapshotKey,
} from "../snapshot-key.js";
import type { CanvasExternalComponentRef } from "../types.js";
import { isExternalSourceRef, isLocalSourceRef } from "../types.js";

const DIGEST = "sha256-47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";

// biome-ignore lint/suspicious/noControlCharactersInRegex: these exact characters are what the codec rejects, so a test for it must name them
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F\u0080-\u009F]/;
const UNPAIRED_SURROGATE_RE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The field values the codec accepts — the complement of its documented rejects. */
function isLegalRefField(value: string): boolean {
	return !CONTROL_CHARS_RE.test(value) && !UNPAIRED_SURROGATE_RE.test(value);
}

function ref(
	overrides: Partial<CanvasExternalComponentRef> = {},
): CanvasExternalComponentRef {
	return {
		kind: "library",
		libraryId: "acme-brand",
		componentId: "button-primary",
		version: "1.4.2",
		integrity: DIGEST,
		...overrides,
	};
}

describe("snapshotKey / parseSnapshotKey — round trip (T-005)", () => {
	it("produces the documented four-segment shape", () => {
		expect(snapshotKey(ref())).toBe(
			`acme-brand/button-primary/1.4.2/${DIGEST}`,
		);
	});

	it("round-trips losslessly", () => {
		const original = ref();
		const parsed = parseSnapshotKey(snapshotKey(original));
		expect(parsed).toEqual(original);
	});

	it("round-trips values that contain the delimiter", () => {
		// The whole reason encodeURIComponent was chosen: `/` cannot bleed across
		// segments, so a library id containing a slash is still exactly four fields.
		const original = ref({
			libraryId: "acme/brand/nested",
			componentId: "a/b",
			version: "1.0.0/beta",
		});
		const key = snapshotKey(original);
		expect(key.split("/")).toHaveLength(4);
		expect(parseSnapshotKey(key)).toEqual(original);
	});

	it("round-trips unicode, emoji, and percent-looking values", () => {
		for (const value of [
			"日本語ライブラリ",
			"emoji-🎨-kit",
			"100%-cotton",
			"a%2Fb",
			"has space",
			"tilde~dot.bang!star*paren()quote'",
		]) {
			const original = ref({ libraryId: value, componentId: value });
			expect(parseSnapshotKey(snapshotKey(original))).toEqual(original);
		}
	});

	it("round-trips arbitrary legal field values (property)", () => {
		const legalField = fc
			.string({ minLength: 1, maxLength: 64 })
			// Exclude control characters and unpaired surrogates, which are the
			// documented rejects rather than round-trip inputs.
			.filter(isLegalRefField);

		fc.assert(
			fc.property(
				legalField,
				legalField,
				legalField,
				legalField,
				(libraryId, componentId, version, integrity) => {
					const original: CanvasExternalComponentRef = {
						kind: "library",
						libraryId,
						componentId,
						version,
						integrity,
					};
					expect(parseSnapshotKey(snapshotKey(original))).toEqual(original);
				},
			),
			{ numRuns: 300 },
		);
	});
});

describe("snapshot key — prototype pollution is structurally impossible (SEC)", () => {
	it("no valid key can equal a dangerous property name", () => {
		for (const dangerous of [
			"__proto__",
			"constructor",
			"prototype",
			"toString",
			"valueOf",
			"__defineGetter__",
		]) {
			// A key needs exactly three unescaped separators; none of these has any.
			expect(isSnapshotKey(dangerous)).toBe(false);
			expect(parseSnapshotKey(dangerous)).toBeNull();
		}
	});

	it("a ref whose fields ARE those names still yields a safe four-segment key", () => {
		const original = ref({
			libraryId: "__proto__",
			componentId: "constructor",
			version: "prototype",
			integrity: "__proto__",
		});
		const key = snapshotKey(original);
		expect(key).toBe("__proto__/constructor/prototype/__proto__");
		expect(key).not.toBe("__proto__");
		expect(key.split("/")).toHaveLength(4);
		// And it still round-trips — the values are data, not structure.
		expect(parseSnapshotKey(key)).toEqual(original);
	});
});

describe("parseSnapshotKey — rejects malformed keys (SEC)", () => {
	it("rejects wrong segment counts", () => {
		for (const key of [
			"",
			"a",
			"a/b",
			"a/b/c",
			"a/b/c/d/e",
			"/b/c/d",
			"a//c/d",
			"a/b/c/",
			"///",
		]) {
			expect(parseSnapshotKey(key)).toBeNull();
		}
	});

	it("rejects malformed percent-escapes", () => {
		for (const key of ["%/b/c/d", "a/%zz/c/d", "a/b/%E0%A4/d", "a/b/c/%"]) {
			expect(parseSnapshotKey(key)).toBeNull();
		}
	});

	it("rejects decoded C0/C1 control characters", () => {
		// %00 NUL, %1F unit separator, %7F DEL, %C2%80 first C1.
		for (const encoded of ["%00", "%1F", "%7F", "%C2%80", "%C2%9F"]) {
			expect(parseSnapshotKey(`${encoded}/b/c/d`)).toBeNull();
			expect(parseSnapshotKey(`a/b/c/x${encoded}`)).toBeNull();
		}
	});

	it("rejects a decoded field longer than the documented ceiling", () => {
		const tooLong = "x".repeat(MAX_EXTERNAL_REF_FIELD_CHARS + 1);
		const atLimit = "x".repeat(MAX_EXTERNAL_REF_FIELD_CHARS);
		expect(parseSnapshotKey(`${tooLong}/b/c/d`)).toBeNull();
		expect(parseSnapshotKey(`${atLimit}/b/c/d`)).not.toBeNull();
	});

	it("rejects non-canonical encodings of the same reference", () => {
		// `~` is NOT escaped by encodeURIComponent, so `%7E` decodes to the same
		// value but is not the key this codec produces. Accepting it would let one
		// component occupy two registry slots.
		expect(parseSnapshotKey("a%7Eb/c/d/e")).toBeNull();
		expect(parseSnapshotKey("a~b/c/d/e")).not.toBeNull();
		// Uppercase vs lowercase escape hex likewise.
		expect(parseSnapshotKey("a%2fb/c/d/e")).toBeNull();
		expect(parseSnapshotKey("a%2Fb/c/d/e")).not.toBeNull();
	});

	it("rejects non-string input", () => {
		for (const value of [undefined, null, 42, {}, [], Symbol("x")]) {
			expect(parseSnapshotKey(value)).toBeNull();
		}
	});
});

describe("snapshotKey — refuses to build an invalid key (SEC)", () => {
	it("throws a typed error naming the offending field", () => {
		const cases: ReadonlyArray<
			[Partial<CanvasExternalComponentRef>, string, string]
		> = [
			[{ libraryId: "" }, "field-empty", "libraryId"],
			[{ componentId: "" }, "field-empty", "componentId"],
			[
				{ version: "x".repeat(MAX_EXTERNAL_REF_FIELD_CHARS + 1) },
				"field-too-long",
				"version",
			],
			[
				{ integrity: "bad\u0000digest" },
				"field-control-character",
				"integrity",
			],
			[
				{ libraryId: "lone\uD800surrogate" },
				"field-unpaired-surrogate",
				"libraryId",
			],
			[
				{ componentId: undefined as unknown as string },
				"field-not-a-string",
				"componentId",
			],
		];

		for (const [overrides, code, fieldName] of cases) {
			let caught: unknown;
			try {
				snapshotKey(ref(overrides));
			} catch (error) {
				caught = error;
			}
			expect(caught, `${code} for ${fieldName}`).toBeInstanceOf(
				CanvasSnapshotKeyError,
			);
			const error = caught as CanvasSnapshotKeyError;
			expect(error.code).toBe(code);
			expect(error.message).toContain(fieldName);
			expect(error.name).toBe("CanvasSnapshotKeyError");
		}
	});

	it("accepts a field exactly at the ceiling", () => {
		expect(() =>
			snapshotKey(ref({ libraryId: "x".repeat(MAX_EXTERNAL_REF_FIELD_CHARS) })),
		).not.toThrow();
	});
});

describe("snapshot key — collisions (SEC)", () => {
	it("two distinct references never share a key", () => {
		const base = ref();
		const variants: CanvasExternalComponentRef[] = [
			base,
			ref({ libraryId: "acme-brand2" }),
			ref({ componentId: "button-primary2" }),
			ref({ version: "1.4.3" }),
			ref({ integrity: `${DIGEST}X` }),
			// The separator-injection attempt: these differ only in where the `/`
			// sits, which an unescaped join would collapse to one key.
			ref({ libraryId: "a/b", componentId: "c" }),
			ref({ libraryId: "a", componentId: "b/c" }),
			ref({ libraryId: "a", componentId: "b", version: "c/1.0.0" }),
		];

		const keys = variants.map(snapshotKey);
		expect(new Set(keys).size).toBe(variants.length);
	});

	it("distinct refs yield distinct keys (property)", () => {
		const field = fc
			.string({ minLength: 1, maxLength: 24 })
			.filter(isLegalRefField);

		fc.assert(
			fc.property(
				fc.tuple(field, field, field, field),
				fc.tuple(field, field, field, field),
				(a, b) => {
					const refA = ref({
						libraryId: a[0],
						componentId: a[1],
						version: a[2],
						integrity: a[3],
					});
					const refB = ref({
						libraryId: b[0],
						componentId: b[1],
						version: b[2],
						integrity: b[3],
					});
					const same = a.join("\u0000") === b.join("\u0000");
					expect(snapshotKey(refA) === snapshotKey(refB)).toBe(same);
				},
			),
			{ numRuns: 300 },
		);
	});

	it("the same logical version with different bytes is a DIFFERENT key", () => {
		// TD §22.1 same-version content substitution: integrity is part of the key,
		// so republished bytes cannot overwrite a trusted snapshot.
		const a = ref({ integrity: "sha256-AAAA" });
		const b = ref({ integrity: "sha256-BBBB" });
		expect(a.version).toBe(b.version);
		expect(snapshotKey(a)).not.toBe(snapshotKey(b));
	});
});

describe("keyShapeImpliesFourSegments — the invariant parse relies on", () => {
	it("any key matching the shape splits into exactly four segments", () => {
		// `parseSnapshotKey` deliberately carries no runtime segment-count check,
		// because the regex makes one unreachable. This is what holds that claim up.
		const shape = /^[^/]+\/[^/]+\/[^/]+\/[^/]+$/;
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (candidate) => {
				if (!shape.test(candidate)) return;
				expect(candidate.split("/")).toHaveLength(4);
			}),
			{ numRuns: 500 },
		);
		// Plus explicit cases, since random strings rarely match the shape.
		for (const key of ["a/b/c/d", "%2F/b/c/d", "x/y/z/w", "1/2/3/4"]) {
			expect(shape.test(key)).toBe(true);
			expect(key.split("/")).toHaveLength(4);
		}
	});
});

describe("SnapshotKeySchema", () => {
	it("accepts a produced key and rejects a malformed one", () => {
		expect(SnapshotKeySchema.safeParse(snapshotKey(ref())).success).toBe(true);
		expect(SnapshotKeySchema.safeParse("__proto__").success).toBe(false);
		expect(SnapshotKeySchema.safeParse("a/b/c").success).toBe(false);
	});
});

describe("CanvasExternalComponentRefSchema — exact versions only (T-010)", () => {
	it("accepts an exact reference", () => {
		expect(CanvasExternalComponentRefSchema.safeParse(ref()).success).toBe(
			true,
		);
	});

	it("accepts opaque version styles hosts actually use", () => {
		for (const version of [
			"1.4.2",
			"2026.07.30",
			"v3",
			"1.0.0-rc.1",
			"1.0.0+build.5",
			"deadbeefcafe",
			"20260730T120000Z",
		]) {
			const result = CanvasExternalComponentRefSchema.safeParse(
				ref({ version }),
			);
			expect(result.success, `should accept ${version}`).toBe(true);
		}
	});

	it("rejects latest, ranges, channels, and wildcards at PARSE time", () => {
		for (const version of [
			"latest",
			"LATEST",
			"  latest  ",
			"next",
			"stable",
			"canary",
			"^1.0.0",
			"~1.0.0",
			">=1.0.0",
			"<2.0.0",
			"1.0.0 || 2.0.0",
			"1.x",
			"1.2.x",
			"1.X",
			"*",
			"1 - 2",
		]) {
			const result = CanvasExternalComponentRefSchema.safeParse(
				ref({ version }),
			);
			expect(result.success, `should reject ${version}`).toBe(false);
		}
	});

	it("names the rule in the rejection message", () => {
		const result = CanvasExternalComponentRefSchema.safeParse(
			ref({ version: "latest" }),
		);
		expect(result.success).toBe(false);
		if (!result.success) {
			const message = result.error.issues.map((i) => i.message).join(" ");
			expect(message).toMatch(/floating channel/);
			expect(message).toMatch(/equality only/);
			expect(result.error.issues[0]?.path).toEqual(["version"]);
		}
	});

	it("rejects empty fields", () => {
		for (const key of [
			"libraryId",
			"componentId",
			"version",
			"integrity",
		] as const) {
			expect(
				CanvasExternalComponentRefSchema.safeParse(ref({ [key]: "" })).success,
			).toBe(false);
		}
	});

	it("rejects an over-long field and control characters", () => {
		expect(
			CanvasExternalComponentRefSchema.safeParse(
				ref({ libraryId: "x".repeat(MAX_EXTERNAL_REF_FIELD_CHARS + 1) }),
			).success,
		).toBe(false);
		expect(
			CanvasExternalComponentRefSchema.safeParse(
				ref({ libraryId: "bad\u0000id" }),
			).success,
		).toBe(false);
	});

	it("rejects a malformed integrity shape but not the algorithm choice", () => {
		// Shape is this schema's job; the supported-algorithm allowlist is
		// parseIntegrity's (T-007), so an unknown-but-well-shaped algorithm parses.
		expect(
			CanvasExternalComponentRefSchema.safeParse(
				ref({ integrity: "sha512-AAAA" }),
			).success,
		).toBe(true);
		for (const integrity of ["nodash", "-leading", "sha256-", "sha256-!!!"]) {
			expect(
				CanvasExternalComponentRefSchema.safeParse(ref({ integrity })).success,
				`should reject ${integrity}`,
			).toBe(false);
		}
	});

	it("rejects unknown keys — strict at the trust boundary (OD-01)", () => {
		const result = CanvasExternalComponentRefSchema.safeParse({
			...ref(),
			evilExtra: "payload",
		});
		expect(result.success).toBe(false);
	});

	it("rejects the wrong kind", () => {
		expect(
			CanvasExternalComponentRefSchema.safeParse({
				...ref(),
				kind: "local",
			}).success,
		).toBe(false);
	});
});

describe("CanvasComponentSourceRefSchema", () => {
	it("accepts both source kinds", () => {
		expect(
			CanvasComponentSourceRefSchema.safeParse({
				kind: "local",
				componentId: "button",
			}).success,
		).toBe(true);
		expect(CanvasComponentSourceRefSchema.safeParse(ref()).success).toBe(true);
	});

	it("applies the version rule through the union too", () => {
		expect(
			CanvasComponentSourceRefSchema.safeParse(ref({ version: "latest" }))
				.success,
		).toBe(false);
	});

	it("rejects an unknown kind and unknown keys", () => {
		expect(
			CanvasComponentSourceRefSchema.safeParse({ kind: "remote", id: "x" })
				.success,
		).toBe(false);
		expect(
			CanvasComponentSourceRefSchema.safeParse({
				kind: "local",
				componentId: "button",
				extra: 1,
			}).success,
		).toBe(false);
	});

	it("narrows with the type guards", () => {
		const external = ref();
		const local = { kind: "local", componentId: "button" } as const;
		expect(isExternalSourceRef(external)).toBe(true);
		expect(isLocalSourceRef(external)).toBe(false);
		expect(isLocalSourceRef(local)).toBe(true);
		expect(isExternalSourceRef(local)).toBe(false);
	});
});
