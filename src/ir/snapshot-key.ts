import { z } from "zod";

import { MAX_EXTERNAL_REF_FIELD_CHARS } from "../limits.js";
import type { CanvasExternalComponentRef } from "./component-source.js";

/**
 * Snapshot-registry key codec (plan 0021 T-005/T-014, TD 0016 §5.3, OD-04).
 *
 * ## Why this lives in `ir/` (rank 1) and not in `component-libraries/` (rank 4)
 *
 * `CanvasIR.externalComponentSnapshots` is keyed by these strings, and its schema
 * in `ir/validators.ts` asserts `key === snapshotKey(entry.ref)` — the check that
 * defeats cross-library snapshot confusion (TD §22.1). Rank 1 cannot import
 * upward, so the codec has to be here for that assertion to exist at all. This
 * was recorded as M0 follow-up #1 and is the same relocation
 * `ir/component-source.ts` made for the ref types.
 *
 * `CanvasSnapshotKeyError` moved with it: an error thrown by this codec belongs
 * beside the codec. `component-libraries/{snapshot-key,errors}.ts` re-export both,
 * so the published subpath surface is unchanged.
 */

/**
 * Why a snapshot key could not be derived from a reference.
 *
 * Separate from the resource-limit codes (`CanvasComponentLimitCode`, in
 * `component-libraries/errors.ts`) even though `field-too-long`
 * looks like a cap: these describe a *malformed reference*, which is a
 * correctness failure in whatever produced it, not an oversized-but-well-formed
 * payload from a remote. Conflating them would make "the Provider sent too much"
 * indistinguishable from "we built an invalid key".
 */
export type CanvasSnapshotKeyErrorCode =
	| "field-not-a-string"
	| "field-empty"
	| "field-too-long"
	| "field-control-character"
	| "field-unpaired-surrogate";

/**
 * A reference field was unfit to encode into a registry key.
 *
 * Thrown by `snapshotKey`, never by `parseSnapshotKey` — deriving a key is how
 * data enters the document, so an invalid one must not be constructible; parsing
 * reads untrusted input and returns `null` instead.
 */
export class CanvasSnapshotKeyError extends Error {
	readonly code: CanvasSnapshotKeyErrorCode;

	constructor(code: CanvasSnapshotKeyErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "CanvasSnapshotKeyError";
		this.code = code;
	}
}

/**
 * Why a payload has no canonical form.
 *
 * Every member describes an input that would otherwise produce a digest that is
 * either non-deterministic or ambiguous — i.e. two different payloads hashing to
 * the same bytes, or one payload hashing differently on two runs. Canonicalizing
 * such a payload is worse than refusing it, because the failure would surface
 * much later as an integrity mismatch on a document that was never actually
 * tampered with.
 */


/** Exactly four non-empty, `/`-free segments. */
const KEY_SHAPE_RE = /^[^/]+\/[^/]+\/[^/]+\/[^/]+$/;

/**
 * C0 (U+0000–U+001F), DEL (U+007F), and C1 (U+0080–U+009F) control characters.
 *
 * Checked against the **decoded** field, not the key: `encodeURIComponent`
 * percent-escapes every one of these, so a key produced by this module never
 * contains a raw control character — but a hand-authored or hostile key can
 * carry `%00`, and that decodes to one.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting these exact characters is the point
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F\u0080-\u009F]/;

/** Lone (unpaired) surrogate, which `encodeURIComponent` cannot encode. */
const UNPAIRED_SURROGATE_RE =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const FIELD_NAMES = [
	"libraryId",
	"componentId",
	"version",
	"integrity",
] as const;

/**
 * Validate one reference field, returning `null` when it is acceptable or a
 * {@link CanvasSnapshotKeyError} code when it is not.
 */
function fieldProblem(value: unknown): {
	code:
		| "field-not-a-string"
		| "field-empty"
		| "field-too-long"
		| "field-control-character"
		| "field-unpaired-surrogate";
	detail: string;
} | null {
	if (typeof value !== "string") {
		return { code: "field-not-a-string", detail: `got ${typeof value}` };
	}
	if (value.length === 0) {
		return { code: "field-empty", detail: "empty string" };
	}
	if (value.length > MAX_EXTERNAL_REF_FIELD_CHARS) {
		return {
			code: "field-too-long",
			detail: `${value.length} chars (max ${MAX_EXTERNAL_REF_FIELD_CHARS})`,
		};
	}
	if (CONTROL_CHARS_RE.test(value)) {
		return {
			code: "field-control-character",
			detail: "contains a C0/C1 control character",
		};
	}
	// `encodeURIComponent` throws URIError on a lone surrogate, so rejecting it
	// here turns an opaque platform throw into a typed, named failure.
	if (UNPAIRED_SURROGATE_RE.test(value)) {
		return {
			code: "field-unpaired-surrogate",
			detail: "contains an unpaired surrogate",
		};
	}
	return null;
}

/**
 * Derive the registry key for an exact external reference.
 *
 * @throws {CanvasSnapshotKeyError} when any field is absent, empty, longer than
 * {@link MAX_EXTERNAL_REF_FIELD_CHARS}, or contains a control character or
 * unpaired surrogate.
 */
export function snapshotKey(ref: CanvasExternalComponentRef): string {
	const fields = FIELD_NAMES.map((name) => ref?.[name]);

	for (const [index, value] of fields.entries()) {
		const problem = fieldProblem(value);
		if (problem) {
			throw new CanvasSnapshotKeyError(
				problem.code,
				`${FIELD_NAMES[index]}: ${problem.detail}`,
			);
		}
	}

	return (fields as string[]).map(encodeURIComponent).join("/");
}

/**
 * Parse a registry key back into its exact reference, or `null` when the key is
 * not one this codec could have produced.
 *
 * Total and non-throwing by design — see the module note on direction of
 * strictness.
 */
export function parseSnapshotKey(
	key: unknown,
): CanvasExternalComponentRef | null {
	if (typeof key !== "string") return null;
	if (!KEY_SHAPE_RE.test(key)) return null;

	// `KEY_SHAPE_RE` matched, so there are exactly three unescaped separators and
	// four non-empty segments — `split` cannot return any other length here. No
	// runtime length check follows, because it would be unreachable code that no
	// test could ever cover; the guarantee lives in the regex, and
	// `keyShapeImpliesFourSegments` in the tests pins it.
	const segments = key.split("/");

	const decoded: string[] = [];
	for (const segment of segments) {
		let value: string;
		try {
			value = decodeURIComponent(segment);
		} catch {
			// Malformed percent-escape (e.g. "%", "%zz", "%E0%A4").
			return null;
		}
		if (fieldProblem(value)) return null;
		decoded.push(value);
	}

	const [libraryId, componentId, version, integrity] = decoded as [
		string,
		string,
		string,
		string,
	];

	// Round-trip check: re-encoding must reproduce the key exactly. This rejects
	// non-canonical encodings of the same reference — `%7E` vs `~`, `a%2Fb` vs a
	// value that merely decodes alike — so one reference has exactly one key and
	// a registry cannot hold the same component twice under two spellings.
	const canonical = [libraryId, componentId, version, integrity]
		.map(encodeURIComponent)
		.join("/");
	if (canonical !== key) return null;

	return { kind: "library", libraryId, componentId, version, integrity };
}

/** Whether `key` is a well-formed snapshot key. */
export function isSnapshotKey(key: unknown): key is string {
	return parseSnapshotKey(key) !== null;
}

/**
 * Zod schema for the keys of `CanvasIR.externalComponentSnapshots`.
 *
 * Used as the record's key schema in M1 (T-014), which additionally asserts that
 * every key equals `snapshotKey(entry.ref)` — the check that defeats
 * cross-library snapshot confusion (TD §22.1). Validation is delegated to
 * {@link parseSnapshotKey} rather than restated as a regex, so the schema and the
 * codec cannot disagree about what a key is.
 */
export const SnapshotKeySchema: z.ZodType<string> = z
	.string()
	.refine((value) => isSnapshotKey(value), {
		message:
			"must be a snapshot key of the form libraryId/componentId/version/integrity, each segment URI-component-encoded, 1-256 characters, free of C0/C1 control characters",
	});
