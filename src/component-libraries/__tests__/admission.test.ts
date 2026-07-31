import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";
import { createCanvasIR } from "../../ir/builders.js";
import { CanvasIRSchema } from "../../ir/validators.js";
import { MAX_EXTERNAL_ENVELOPE_BYTES } from "../../limits.js";
import {
	admitExternalSnapshot,
	CANVAS_CANONICAL_FORMAT_VERSION,
	CanvasExternalComponentEnvelopeSchema,
	type CanvasExternalComponentSnapshotLike,
	type CanvasValidatedExternalSnapshot,
} from "../admission.js";
import { canonicalizeComponentPayload } from "../canonicalize.js";
import {
	CANVAS_INTEGRITY_ALGORITHM,
	type CanvasIntegrityVerifier,
	digestsEqual,
	formatIntegrity,
	parseIntegrity,
} from "../integrity.js";
import { snapshotKey } from "../snapshot-key.js";
import type { CanvasExternalComponentRef } from "../types.js";

/**
 * T-007 (verifier contract) and T-008 (strict envelope + branded admission).
 */

// --- helpers ---------------------------------------------------------------

function base64url(buffer: Buffer): string {
	return buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Node-side reference digest, independent of any adapter under test. */
function sha256Base64Url(bytes: Uint8Array): string {
	return base64url(createHash("sha256").update(bytes).digest());
}

/**
 * A REAL component definition, not a placeholder.
 *
 * M0 carried `definition` as `z.unknown()`, so a three-field stub was enough.
 * T-014 gave the envelope the actual definition schema over the IR node union,
 * which means the fixture now has to be a component a document could genuinely
 * hold — including a well-formed `root` node and a `properties` array.
 */
const DEFINITION = {
	id: "button-primary",
	name: "Primary Button",
	revision: 1,
	root: {
		id: "button-root",
		type: "rect",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 120, height: 40 },
		zIndex: 0,
		fill: "#2563eb",
	},
	properties: [],
};

function envelope(
	overrides: Record<string, unknown> = {},
	refOverrides: Partial<CanvasExternalComponentRef> = {},
) {
	const ref: CanvasExternalComponentRef = {
		kind: "library",
		libraryId: "acme-brand",
		componentId: "button-primary",
		version: "1.4.2",
		integrity: `${CANVAS_INTEGRITY_ALGORITHM}-${"A".repeat(43)}`,
		...refOverrides,
	};
	return {
		ref,
		canonicalFormatVersion: CANVAS_CANONICAL_FORMAT_VERSION,
		definition: DEFINITION,
		dependencies: [],
		...overrides,
	};
}

/** Build an envelope whose declared integrity is the CORRECT digest. */
function authenticEnvelope(overrides: Record<string, unknown> = {}) {
	const draft = envelope(overrides);
	const subject = {
		canonicalFormatVersion: draft.canonicalFormatVersion,
		libraryId: draft.ref.libraryId,
		componentId: draft.ref.componentId,
		version: draft.ref.version,
		definition: draft.definition,
		dependencies: draft.dependencies,
	};
	const digest = sha256Base64Url(canonicalizeComponentPayload(subject));
	return {
		...draft,
		ref: { ...draft.ref, integrity: `sha256-${digest}` },
	};
}

/** A verifier that recomputes the digest for real. */
const realVerifier: CanvasIntegrityVerifier = {
	async verify({ canonicalBytes, expectedDigest }) {
		return digestsEqual(sha256Base64Url(canonicalBytes), expectedDigest);
	},
};

const alwaysTrue: CanvasIntegrityVerifier = {
	async verify() {
		return true;
	},
};
const alwaysFalse: CanvasIntegrityVerifier = {
	async verify() {
		return false;
	},
};

// --- T-007: integrity format ----------------------------------------------

describe("parseIntegrity (T-007)", () => {
	it("accepts a well-formed sha256 digest", () => {
		const digest = sha256Base64Url(new Uint8Array([1, 2, 3]));
		const result = parseIntegrity(`sha256-${digest}`);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.algorithm).toBe("sha256");
			expect(result.value.digest).toBe(digest);
		}
	});

	it("tolerates base64url padding and normalizes it away", () => {
		const digest = sha256Base64Url(new Uint8Array([1]));
		const padded = parseIntegrity(`sha256-${digest}=`);
		expect(padded.ok).toBe(true);
		if (padded.ok) expect(padded.value.digest).toBe(digest);
	});

	it("rejects an unsupported algorithm with an integrity diagnostic, never a throw", () => {
		for (const algorithm of ["sha512", "sha1", "md5", "blake3", "SHA256"]) {
			const digest = "A".repeat(43);
			let result: ReturnType<typeof parseIntegrity> | undefined;
			expect(() => {
				result = parseIntegrity(`${algorithm}-${digest}`);
			}).not.toThrow();
			expect(result?.ok).toBe(false);
			if (result && !result.ok) {
				// T-007 acceptance: a `component-integrity-mismatch`-class diagnostic.
				expect(result.diagnostic.code).toBe("component-integrity-mismatch");
				expect(result.diagnostic.message).toContain(algorithm);
				expect(result.diagnostic.severity).toBe("error");
			}
		}
	});

	it("rejects malformed input without throwing", () => {
		for (const value of [
			undefined,
			null,
			42,
			{},
			"",
			"sha256",
			"-AAAA",
			"sha256-",
			`sha256-${"!".repeat(43)}`,
			`sha256-${"A".repeat(42)}`,
			`sha256-${"A".repeat(44)}`,
		]) {
			let result: ReturnType<typeof parseIntegrity> | undefined;
			expect(() => {
				result = parseIntegrity(value);
			}).not.toThrow();
			expect(result?.ok, `should reject ${String(value)}`).toBe(false);
		}
	});

	it("matches a known-answer SHA-256 vector (T-007 acceptance)", () => {
		// RFC 6234 / NIST: SHA-256("abc") =
		// ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
		const expectedHex =
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
		const bytes = new TextEncoder().encode("abc");
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedHex);
		// ...and the base64url form our contract carries round-trips through
		// parseIntegrity unchanged.
		const digest = base64url(Buffer.from(expectedHex, "hex"));
		const parsed = parseIntegrity(`sha256-${digest}`);
		expect(parsed.ok).toBe(true);
		if (parsed.ok)
			expect(formatIntegrity(parsed.value)).toBe(`sha256-${digest}`);
	});

	it("SHA-256 of the empty input is the documented vector", () => {
		expect(sha256Base64Url(new Uint8Array())).toBe(
			"47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
		);
	});
});

describe("digestsEqual", () => {
	it("is padding-insensitive and length-safe", () => {
		expect(digestsEqual("AAAA", "AAAA")).toBe(true);
		expect(digestsEqual("AAAA=", "AAAA")).toBe(true);
		expect(digestsEqual("AAAA", "AAAB")).toBe(false);
		expect(digestsEqual("AAAA", "AAA")).toBe(false);
		expect(digestsEqual("", "")).toBe(true);
	});

	it("differs only on content, not on where the difference is", () => {
		const base = "A".repeat(43);
		expect(digestsEqual(base, `B${base.slice(1)}`)).toBe(false);
		expect(digestsEqual(base, `${base.slice(0, -1)}B`)).toBe(false);
	});
});

// --- T-008: strict envelope ------------------------------------------------

describe("envelope parsing is STRICT, IR parsing stays LOOSE (T-008, OD-01)", () => {
	it("rejects an unknown key on the envelope", () => {
		const result = CanvasExternalComponentEnvelopeSchema.safeParse({
			...envelope(),
			smuggled: "payload",
		});
		expect(result.success).toBe(false);
	});

	it("rejects an unknown key on nested catalog metadata too", () => {
		const result = CanvasExternalComponentEnvelopeSchema.safeParse({
			...envelope(),
			metadata: { name: "Button", sneaky: 1 },
		});
		expect(result.success).toBe(false);
	});

	it("PRESERVES unknown keys on an IR document — the other half of the asymmetry", () => {
		// `ir/validators.ts:40-46` documents why: the IR is a CRDT wire format, so a
		// replica on an older build must round-trip a newer peer's fields. Asserting
		// both postures in one test is what stops someone "harmonizing" them.
		const document = {
			...createCanvasIR({
				id: "doc-loose",
				now: () => "2026-01-01T00:00:00.000Z",
			}),
			futureFieldFromNewerPeer: { keepMe: true },
		};
		const parsed = CanvasIRSchema.safeParse(document);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(
				(parsed.data as unknown as Record<string, unknown>)
					.futureFieldFromNewerPeer,
			).toEqual({ keepMe: true });
		}
	});

	it("sanitizes provider URLs to undefined instead of failing the envelope", () => {
		// A javascript: thumbnail is a reason to render no thumbnail, not a reason to
		// reject an otherwise authentic component.
		const result = CanvasExternalComponentEnvelopeSchema.safeParse({
			...envelope(),
			metadata: {
				thumbnailUrl: "javascript:alert(1)",
				releaseNotesUrl: "https://example.com/notes",
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.metadata?.thumbnailUrl).toBeUndefined();
			expect(result.data.metadata?.releaseNotesUrl).toBe(
				"https://example.com/notes",
			);
		}
	});

	it("rejects a wrong canonicalFormatVersion", () => {
		expect(
			CanvasExternalComponentEnvelopeSchema.safeParse({
				...envelope(),
				canonicalFormatVersion: 2,
			}).success,
		).toBe(false);
	});

	it("rejects too many direct dependencies", () => {
		expect(
			CanvasExternalComponentEnvelopeSchema.safeParse({
				...envelope(),
				dependencies: Array.from({ length: 1_000 }, (_, i) => ({ i })),
			}).success,
		).toBe(false);
	});
});

// --- T-008: the brand ------------------------------------------------------

describe("CanvasValidatedExternalSnapshot is unforgeable (T-008, SEC)", () => {
	it("a hand-built object literal does not satisfy the branded type", () => {
		const plain: CanvasExternalComponentSnapshotLike = {
			ref: envelope().ref,
			definition: DEFINITION,
			dependencies: [],
			canonicalFormatVersion: CANVAS_CANONICAL_FORMAT_VERSION,
		};
		// The whole point: no module outside `admission.ts` can name the brand
		// symbol, so no object literal can carry it.
		expectTypeOf(plain).not.toEqualTypeOf<CanvasValidatedExternalSnapshot>();
		expectTypeOf<CanvasExternalComponentSnapshotLike>().not.toExtend<CanvasValidatedExternalSnapshot>();
		// @ts-expect-error an unbranded snapshot is not assignable to the branded type
		const forged: CanvasValidatedExternalSnapshot = plain;
		expect(forged).toBeDefined();
	});

	it("a branded snapshot IS assignable to the unbranded shape", () => {
		// Branding must not make the value harder to read — only harder to fake.
		expectTypeOf<CanvasValidatedExternalSnapshot>().toExtend<CanvasExternalComponentSnapshotLike>();
	});
});

// --- T-008: the pipeline ---------------------------------------------------

describe("admitExternalSnapshot", () => {
	it("admits an authentic envelope and returns its key and canonical bytes", async () => {
		const input = authenticEnvelope();
		const result = await admitExternalSnapshot(input, {
			verifier: realVerifier,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.key).toBe(snapshotKey(input.ref));
			expect(result.canonicalBytes).toBeInstanceOf(Uint8Array);
			expect(result.snapshot.ref).toEqual(input.ref);
			expect(result.snapshot.definition).toEqual(DEFINITION);
		}
	});

	it("rejects when the digest does not match", async () => {
		const result = await admitExternalSnapshot(envelope(), {
			verifier: realVerifier,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostic.code).toBe("component-integrity-mismatch");
			expect(result.diagnostic.snapshotKey).toBeDefined();
		}
	});

	it("distinguishes 'did not match' from 'could not check'", async () => {
		const mismatch = await admitExternalSnapshot(authenticEnvelope(), {
			verifier: alwaysFalse,
		});
		expect(mismatch.ok).toBe(false);
		if (!mismatch.ok) {
			expect(mismatch.diagnostic.message).toContain("do not match");
		}

		const unavailable = await admitExternalSnapshot(authenticEnvelope(), {
			verifier: {
				async verify() {
					throw new Error("crypto.subtle is unavailable");
				},
			},
		});
		expect(unavailable.ok).toBe(false);
		if (!unavailable.ok) {
			expect(unavailable.diagnostic.code).toBe("component-integrity-mismatch");
			expect(unavailable.diagnostic.message).toContain("could not be verified");
		}
	});

	it("refuses an oversized envelope before parsing it", async () => {
		const result = await admitExternalSnapshot(authenticEnvelope(), {
			verifier: alwaysTrue,
			rawByteLength: MAX_EXTERNAL_ENVELOPE_BYTES + 1,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.diagnostic.code).toBe("component-snapshot-invalid");
			expect(result.diagnostic.message).toContain("exceeding");
		}
	});

	it("reports strict-parse failures as component-snapshot-invalid", async () => {
		const result = await admitExternalSnapshot(
			{ ...envelope(), smuggled: true },
			{ verifier: alwaysTrue },
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.diagnostic.code).toBe("component-snapshot-invalid");
	});

	it("rejects a version of `latest` through the ref schema", async () => {
		const result = await admitExternalSnapshot(
			envelope({}, { version: "latest" }),
			{ verifier: alwaysTrue },
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.diagnostic.code).toBe("component-snapshot-invalid");
	});

	it("runs the graph seam BEFORE canonicalizing, and honours its verdict", async () => {
		const calls: string[] = [];
		const result = await admitExternalSnapshot(authenticEnvelope(), {
			verifier: {
				async verify() {
					calls.push("verify");
					return true;
				},
			},
			validateGraph: () => {
				calls.push("graph");
				return {
					code: "component-dependency-missing",
					message: "dep missing",
					severity: "error",
				};
			},
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.diagnostic.code).toBe("component-dependency-missing");
		// A rejected graph must never have its digest computed.
		expect(calls).toEqual(["graph"]);
	});

	it("passes a null graph verdict through", async () => {
		const result = await admitExternalSnapshot(authenticEnvelope(), {
			verifier: realVerifier,
			validateGraph: () => null,
		});
		expect(result.ok).toBe(true);
	});

	it("records fetchedAt once, and excludes it from the digest", async () => {
		const input = authenticEnvelope();
		const withStamp = await admitExternalSnapshot(input, {
			verifier: realVerifier,
			fetchedAt: "2026-07-30T00:00:00.000Z",
		});
		const withoutStamp = await admitExternalSnapshot(input, {
			verifier: realVerifier,
		});
		expect(withStamp.ok && withoutStamp.ok).toBe(true);
		if (withStamp.ok && withoutStamp.ok) {
			expect(withStamp.snapshot.fetchedAt).toBe("2026-07-30T00:00:00.000Z");
			expect(withoutStamp.snapshot.fetchedAt).toBeUndefined();
			// Same bytes despite different fetchedAt — TD §5.4.
			expect(withStamp.canonicalBytes).toEqual(withoutStamp.canonicalBytes);
		}
	});

	it("excludes catalog metadata from the digest", async () => {
		const bare = authenticEnvelope();
		const decorated = {
			...bare,
			metadata: { name: "Renamed", description: "changed later" },
		};
		const a = await admitExternalSnapshot(bare, { verifier: realVerifier });
		const b = await admitExternalSnapshot(decorated, {
			verifier: realVerifier,
		});
		expect(a.ok && b.ok).toBe(true);
		if (a.ok && b.ok) {
			// A cosmetic catalog edit must not invalidate every stored snapshot.
			expect(a.canonicalBytes).toEqual(b.canonicalBytes);
		}
	});

	it("binds the digest to the exact identity — same bytes, different library, different digest", async () => {
		// TD §22.1: content substitution across libraries must not be possible.
		const a = authenticEnvelope();
		const relabelled = { ...a, ref: { ...a.ref, libraryId: "evil-lib" } };
		const result = await admitExternalSnapshot(relabelled, {
			verifier: realVerifier,
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.diagnostic.code).toBe("component-integrity-mismatch");
	});

	it("is insensitive to envelope key order", async () => {
		const input = authenticEnvelope();
		const reordered = {
			dependencies: input.dependencies,
			definition: input.definition,
			canonicalFormatVersion: input.canonicalFormatVersion,
			ref: input.ref,
		};
		const a = await admitExternalSnapshot(input, { verifier: realVerifier });
		const b = await admitExternalSnapshot(reordered, {
			verifier: realVerifier,
		});
		expect(a.ok && b.ok).toBe(true);
		if (a.ok && b.ok) expect(a.canonicalBytes).toEqual(b.canonicalBytes);
	});

	it("reports an unsupported algorithm rather than attempting verification", async () => {
		const calls: string[] = [];
		const result = await admitExternalSnapshot(
			envelope({}, { integrity: `sha512-${"A".repeat(43)}` }),
			{
				verifier: {
					async verify() {
						calls.push("verify");
						return true;
					},
				},
			},
		);
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.diagnostic.code).toBe("component-integrity-mismatch");
		expect(calls).toEqual([]);
	});
});

describe("T-007 DoD — Core contains no direct crypto.subtle call", () => {
	/** Strip block and line comments so a doc reference is not mistaken for a call. */
	function stripComments(source: string): string {
		return source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/.*$/gm, "$1");
	}

	function* sourceFiles(dir: string): Generator<string> {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__tests__" || entry.name === "node_modules")
					continue;
				yield* sourceFiles(full);
				continue;
			}
			if (entry.isFile() && extname(entry.name) === ".ts") yield full;
		}
	}

	it("has no crypto.subtle outside comments anywhere under src/", () => {
		const offenders: string[] = [];
		let scanned = 0;
		for (const file of sourceFiles("src")) {
			scanned += 1;
			const code = stripComments(readFileSync(file, "utf8"));
			if (/crypto\s*\.\s*subtle/.test(code)) offenders.push(file);
		}
		// Guard against the scan silently covering nothing.
		expect(scanned).toBeGreaterThan(50);
		expect(offenders).toEqual([]);
	});

	it("the scan would actually catch a real call", () => {
		// Proves the comment-stripping does not neuter the check.
		const withCall = stripComments(
			"const d = await crypto.subtle.digest('SHA-256', b);",
		);
		expect(/crypto\s*\.\s*subtle/.test(withCall)).toBe(true);
		const withDocRef = stripComments(
			"/** uses crypto.subtle.digest under the hood */",
		);
		expect(/crypto\s*\.\s*subtle/.test(withDocRef)).toBe(false);
		const withLineComment = stripComments("// crypto.subtle.digest is async");
		expect(/crypto\s*\.\s*subtle/.test(withLineComment)).toBe(false);
	});
});
