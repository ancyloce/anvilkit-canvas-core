import {
	type CanvasComponentDiagnostic,
	componentDiagnostic,
} from "./diagnostics.js";

/**
 * Integrity format and verifier contract (plan 0021 T-007, TD 0016 §6.1/§6.3).
 *
 * # Why the digest implementation is injected
 *
 * Not because Core avoids `crypto` — it already calls global `crypto.randomUUID()`
 * directly in `templates/instantiate.ts`, `templates/resize-to-variants.ts`,
 * `commands/change-events.ts`, and `commands/transaction.ts`. The reason is
 * narrower and structural: **`crypto.subtle.digest` returns a Promise, and Core's
 * command application is synchronous end to end.** A digest therefore cannot be
 * computed inside a command, which forces the two-phase design — verify
 * asynchronously *before* the command, hand the command a value that can only
 * exist if verification passed (see `admission.ts`).
 *
 * Injecting it also keeps this package runtime-neutral: Web Crypto, Node crypto,
 * or a host-approved HSM adapter all satisfy the same contract, and
 * `check:react-free-runtime` stays green.
 *
 * **Core contains no direct `crypto.subtle` call** (T-007 DoD). The Web Crypto
 * default lives in `@anvilkit/canvas-editor`
 * (`src/component-libraries/web-crypto-verifier.ts`).
 */

/** The only digest algorithm P0 supports (TD §6.1). */
export const CANVAS_INTEGRITY_ALGORITHM = "sha256" as const;

export type CanvasIntegrityAlgorithm = typeof CANVAS_INTEGRITY_ALGORITHM;

/**
 * Host-supplied digest verification.
 *
 * Exactly the shape in Technical Design §6.3. `verify` resolves `true` only when
 * `canonicalBytes` hashes under `algorithm` to `expectedDigest`. An implementation
 * must **resolve `false`** rather than reject for a mismatch, and should reject
 * only for a genuine environmental failure (no crypto available, hardware error) —
 * that split is what lets a caller distinguish "this snapshot is not authentic"
 * from "we could not check".
 */
export interface CanvasIntegrityVerifier {
	verify(input: {
		algorithm: CanvasIntegrityAlgorithm;
		canonicalBytes: Uint8Array;
		expectedDigest: string;
	}): Promise<boolean>;
}

/** A parsed `sha256-<base64url>` integrity string. */
export interface CanvasParsedIntegrity {
	algorithm: CanvasIntegrityAlgorithm;
	/** base64url digest, padding stripped. */
	digest: string;
}

export type CanvasParseIntegrityResult =
	| { ok: true; value: CanvasParsedIntegrity }
	| { ok: false; diagnostic: CanvasComponentDiagnostic };

/** base64url alphabet, optional `=` padding. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

/**
 * Unpadded base64url length of a 32-byte SHA-256 digest.
 *
 * ceil(32 / 3) * 4 = 44 characters with padding, of which the last is `=`, so 43
 * without. Checking the length here means a truncated or padded-wrong digest is
 * reported as a clear format problem instead of failing later as an
 * indistinguishable "does not match".
 */
const SHA256_BASE64URL_LENGTH = 43;

/**
 * Parse and validate an integrity string.
 *
 * Never throws — an unsupported algorithm or malformed digest comes back as a
 * `component-integrity-mismatch` diagnostic (T-007 acceptance: "never a crash").
 * Adding an algorithm is a reviewed contract extension, not a parser tweak, which
 * is why the allowlist is a single equality check rather than a lookup table
 * someone can quietly extend.
 */
export function parseIntegrity(integrity: unknown): CanvasParseIntegrityResult {
	const reject = (message: string): CanvasParseIntegrityResult => ({
		ok: false,
		diagnostic: componentDiagnostic("component-integrity-mismatch", message),
	});

	if (typeof integrity !== "string" || integrity.length === 0) {
		return reject(
			`integrity must be a non-empty "sha256-<base64url>" string; received ${
				typeof integrity === "string" ? "an empty string" : typeof integrity
			}`,
		);
	}

	const separator = integrity.indexOf("-");
	if (separator <= 0) {
		return reject(
			`integrity "${integrity}" is missing the "<algorithm>-<digest>" separator`,
		);
	}

	const algorithm = integrity.slice(0, separator);
	const digest = integrity.slice(separator + 1);

	if (algorithm !== CANVAS_INTEGRITY_ALGORITHM) {
		return reject(
			`unsupported integrity algorithm "${algorithm}"; only "${CANVAS_INTEGRITY_ALGORITHM}" is supported in P0. Adding an algorithm is a reviewed capability/contract extension (TD §6.1).`,
		);
	}

	if (!BASE64URL_RE.test(digest)) {
		return reject(
			`integrity digest "${digest}" is not base64url (expected only A-Z a-z 0-9 - _ with optional "=" padding)`,
		);
	}

	const unpadded = digest.replace(/=+$/, "");
	if (unpadded.length !== SHA256_BASE64URL_LENGTH) {
		return reject(
			`integrity digest has ${unpadded.length} base64url characters; a ${CANVAS_INTEGRITY_ALGORITHM} digest has exactly ${SHA256_BASE64URL_LENGTH}`,
		);
	}

	return { ok: true, value: { algorithm, digest: unpadded } };
}

/**
 * Compare two base64url digests without an early-exit on the first differing
 * character.
 *
 * ## Why timing is not actually a concern here — and why this is still written this way
 *
 * Neither digest is a secret. The expected digest is stored in the document, ships
 * inside the Provider envelope, and appears verbatim in the snapshot registry key;
 * an attacker who wants it can simply read it. There is no secret to extract, so
 * there is no timing oracle to exploit, and a plain `===` would be correct.
 *
 * It is written this way regardless because the cost is one pass over 43
 * characters, and because "compare digests with ===" is exactly the pattern that
 * gets copied into a context where the compared value *is* secret (an HMAC, a
 * signature, a session token). Making the safe form the local idiom costs nothing
 * and removes that footgun.
 *
 * Padding is normalized first so `AAAA=` and `AAAA` compare equal — they are the
 * same digest, and treating them as different would reject valid Provider output.
 */
export function digestsEqual(a: string, b: string): boolean {
	const left = a.replace(/=+$/, "");
	const right = b.replace(/=+$/, "");
	if (left.length !== right.length) return false;

	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
	}
	return difference === 0;
}

/** Build the canonical `sha256-<digest>` string from a parsed pair. */
export function formatIntegrity(parsed: CanvasParsedIntegrity): string {
	return `${parsed.algorithm}-${parsed.digest.replace(/=+$/, "")}`;
}
