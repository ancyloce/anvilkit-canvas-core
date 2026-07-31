import {
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
} from "../limits.js";

/**
 * Why a resource cap was refused.
 *
 * A **closed** union, deliberately mirroring `CanvasClipboardErrorCode` — the
 * package's existing precedent for "untrusted payload exceeded a documented
 * ceiling". Closed rather than `string` so every producer is exhaustively
 * switchable and no caller can invent a code the UI has no message for
 * (PRD §9.16 acceptance: no `string`-typed error codes in the new surface).
 *
 * Note these are *limit* codes, not the reported
 * `CanvasComponentDiagnosticCode` diagnostics and not the thrown
 * `CanvasCommandErrorCode` codes. Three separate unions because they have three
 * different lifecycles: a limit breach aborts admission before anything enters
 * the IR, a diagnostic is reported about a document that already exists, and a
 * command error rolls back a mutation.
 */
export type CanvasComponentLimitCode =
	| "envelope-too-large"
	| "too-many-snapshots"
	| "too-many-dependencies"
	| "excessive-dependency-depth"
	| "too-many-variants"
	| "too-many-variant-axes"
	| "too-many-variant-values"
	| "field-too-long"
	| "url-too-long"
	| "string-too-long";

/** The documented ceiling each code refuses against, for message construction. */
const LIMIT_FOR_CODE: Readonly<Record<CanvasComponentLimitCode, number>> = {
	"envelope-too-large": MAX_EXTERNAL_ENVELOPE_BYTES,
	"too-many-snapshots": MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT,
	"too-many-dependencies": MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT,
	"excessive-dependency-depth": MAX_EXTERNAL_DEPENDENCY_DEPTH,
	"too-many-variants": MAX_COMPONENT_VARIANTS_PER_COMPONENT,
	"too-many-variant-axes": MAX_COMPONENT_VARIANT_AXES,
	"too-many-variant-values": MAX_COMPONENT_VARIANT_VALUES_PER_AXIS,
	"field-too-long": MAX_EXTERNAL_REF_FIELD_CHARS,
	"url-too-long": MAX_EXTERNAL_URL_CHARS,
	"string-too-long": MAX_EXTERNAL_DISPLAY_STRING_CHARS,
};

/**
 * A Provider envelope (or an imported document's snapshot registry) exceeded a
 * documented resource ceiling.
 *
 * Thrown, not returned, matching `CanvasClipboardError` and
 * `CanvasCommandError`: a cap breach means the input is refused outright, so
 * there is no partial result for a caller to inspect.
 *
 * The message names the observed value, the ceiling, and the constant, because
 * the first question on seeing one of these in a host's logs is always "how far
 * over was it, and can the limit move?".
 */
export class CanvasComponentLimitError extends Error {
	readonly code: CanvasComponentLimitCode;
	/** The documented ceiling that was exceeded. */
	readonly limit: number;
	/** What was actually observed. */
	readonly observed: number;

	constructor(
		code: CanvasComponentLimitCode,
		observed: number,
		detail?: string,
	) {
		const limit = LIMIT_FOR_CODE[code];
		super(
			`${code}: ${observed.toLocaleString()} exceeds the maximum of ${limit.toLocaleString()}${
				detail ? ` (${detail})` : ""
			}`,
		);
		this.name = "CanvasComponentLimitError";
		this.code = code;
		this.limit = limit;
		this.observed = observed;
	}
}

/**
 * Throw {@link CanvasComponentLimitError} when `observed` exceeds the ceiling
 * declared for `code`.
 *
 * The ceiling is looked up from the code rather than passed in, so a call site
 * cannot check a different number than the one documented in `limits.ts` — that
 * drift is exactly what a single central cap module exists to prevent.
 */
export function enforceLimit(
	code: CanvasComponentLimitCode,
	observed: number,
	detail?: string,
): void {
	if (observed > LIMIT_FOR_CODE[code]) {
		throw new CanvasComponentLimitError(code, observed, detail);
	}
}

/** The ceiling enforced for a given limit code. */
export function limitFor(code: CanvasComponentLimitCode): number {
	return LIMIT_FOR_CODE[code];
}

/**
 * Re-exported from `../ir/snapshot-key.js` (rank 1), where the key codec now
 * lives (T-014). It moved because `ir/validators.ts` must assert
 * `key === snapshotKey(entry.ref)` on the persisted registry and cannot import
 * upward from this domain. Kept here so the error type stays discoverable
 * alongside this domain's other errors and the subpath surface is unchanged.
 */
export {
	CanvasSnapshotKeyError,
	type CanvasSnapshotKeyErrorCode,
} from "../ir/snapshot-key.js";

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
export type CanvasCanonicalizationErrorCode =
	| "non-finite-number"
	| "unsupported-type"
	| "cyclic-reference"
	| "depth-exceeded"
	| "duplicate-key-after-normalization";

/** A payload could not be reduced to canonical RFC 8785 bytes. */
export class CanvasCanonicalizationError extends Error {
	readonly code: CanvasCanonicalizationErrorCode;

	constructor(code: CanvasCanonicalizationErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "CanvasCanonicalizationError";
		this.code = code;
	}
}
