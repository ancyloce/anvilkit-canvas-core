import { z } from "zod";
import {
	CanvasComponentDefinitionShape,
	CanvasNodeSchema,
} from "../ir/validators.js";
import {
	MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT,
	MAX_EXTERNAL_ENVELOPE_BYTES,
} from "../limits.js";
import { canonicalizeComponentPayload } from "./canonicalize.js";
import {
	type ClosureResolver,
	type ValidateExternalClosureOptions,
	validateExternalClosure,
} from "./dependencies.js";
import {
	type CanvasComponentDiagnostic,
	componentDiagnostic,
} from "./diagnostics.js";
import { CanvasCanonicalizationError } from "./errors.js";
import {
	CANVAS_INTEGRITY_ALGORITHM,
	type CanvasIntegrityVerifier,
	parseIntegrity,
} from "./integrity.js";
import { CanvasExternalComponentRefSchema } from "./schema.js";
import {
	boundedDisplayString,
	boundedProviderUrl,
	strictEnvelopeObject,
} from "./schema-utils.js";
import { snapshotKey } from "./snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
} from "./types.js";

/**
 * Two-phase admission of an untrusted Provider envelope
 * (plan 0021 T-008, TD 0016 §6.4/§8.1, OD-01/OD-03).
 *
 * # The two phases, and why the boundary is where it is
 *
 * Verification needs `crypto.subtle.digest`, which is **async**. Command
 * application is **sync** end to end (`commands/runtime.ts`). Those two facts
 * cannot be reconciled inside a command, so admission is split:
 *
 * 1. **Async, outside any command** — this module. Strict parse, normalize,
 *    bound, canonicalize, verify. On success it returns a
 *    {@link CanvasValidatedExternalSnapshot}: a *branded* value that carries the
 *    proof of verification in its type.
 * 2. **Sync, inside the command** (M1/T-014, T-021). The command accepts only the
 *    branded type, so "was this verified?" is answered by the type checker rather
 *    than by a runtime flag a caller could set, or by trusting the call order.
 *
 * The brand is why this is sound. Its symbol is module-private, so no code outside
 * this file can construct a value of that type — not with a cast-free object
 * literal, not by spreading a verified one and editing a field.
 *
 * # Scope
 *
 * T-014 replaced M0's opaque `definition`/`dependencies` with their real shapes:
 * the definition is validated as a component definition over the IR node union,
 * and dependencies as exact external refs. Enforced end to end: envelope byte
 * ceiling, top-level strictness, direct-dependency ceiling, definition shape,
 * key derivation, canonicalization, integrity parse, digest verification, and
 * branding.
 *
 * T-017 filled the graph seam: `validateExternalClosure` now runs on every
 * admission, bounding the dependency closure after expansion. Its
 * registry-dependent half (is the closure actually PRESENT) needs a document and
 * is therefore re-checked by the command that commits (T-021).
 */

/** The canonical format version this build produces and accepts (TD §5.3). */
export const CANVAS_CANONICAL_FORMAT_VERSION = 1 as const;

/**
 * Non-authoritative catalog metadata.
 *
 * **Excluded from the canonical preimage** (TD §5.4/§6.2) — a Provider changing a
 * description or thumbnail must not change a component's digest, or every stored
 * snapshot would invalidate on a cosmetic catalog edit.
 */
export const CanvasExternalComponentCatalogMetadataSchema =
	strictEnvelopeObject({
		name: boundedDisplayString().optional(),
		description: boundedDisplayString().optional(),
		publisher: boundedDisplayString().optional(),
		deprecationNotice: boundedDisplayString().optional(),
		releaseNotesUrl: boundedProviderUrl(),
		thumbnailUrl: boundedProviderUrl(),
	});

export type CanvasExternalComponentCatalogMetadata = z.infer<
	typeof CanvasExternalComponentCatalogMetadataSchema
>;

/**
 * The component definition carried by an envelope (plan 0021 T-014).
 *
 * ## Loose, deliberately, inside an otherwise strict envelope
 *
 * The envelope's *top level* is strict — an unknown key there is a malformed
 * request. The definition subtree is **not**, and that asymmetry is load-bearing
 * rather than an oversight:
 *
 * 1. The digest the Provider published was computed over the definition's own
 *    bytes. If parsing stripped a field this build does not know about, the
 *    canonical form would no longer match those bytes and verification would
 *    fail — so a strict definition schema would reject every component authored
 *    by a *newer* Provider, reporting it as an integrity mismatch, which is both
 *    wrong and extremely hard to diagnose.
 * 2. The definition is then stored in the document and replicated to peers, at
 *    which point the CRDT forward-compatibility rule in `ir/validators.ts:40-46`
 *    applies to it exactly as it does to a local Source.
 *
 * Strictness at this boundary buys nothing here: the content is pinned by an
 * exact version and covered by a digest, so unknown fields cannot be substituted
 * without breaking verification. Please do not "fix" this to match the top level.
 */
export const CanvasExternalComponentDefinitionSchema = z.looseObject({
	...CanvasComponentDefinitionShape,
	root: CanvasNodeSchema,
});

/**
 * The Provider envelope.
 *
 * `strictEnvelopeObject` — unknown keys are rejected at the top level. See
 * `schema-utils.ts` for why this is the opposite posture from
 * `ir/validators.ts:40-46`, and why both are correct.
 */
export const CanvasExternalComponentEnvelopeSchema = strictEnvelopeObject({
	ref: CanvasExternalComponentRefSchema,
	canonicalFormatVersion: z.literal(CANVAS_CANONICAL_FORMAT_VERSION),
	definition: CanvasExternalComponentDefinitionSchema,
	dependencies: z
		.array(CanvasExternalComponentRefSchema)
		.max(MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT),
	metadata: CanvasExternalComponentCatalogMetadataSchema.optional(),
});

export type CanvasExternalComponentEnvelope = z.infer<
	typeof CanvasExternalComponentEnvelopeSchema
>;

/**
 * The snapshot shape stored in the document.
 *
 * Since T-014 this is exactly `CanvasExternalComponentSnapshot` from `ir/types.ts`
 * — the persisted shape — rather than a structural stand-in. The alias is kept
 * because it names the *role* ("what admission produces and a command consumes")
 * at every use site, and because it is what the branded type is parameterized on.
 */
export type CanvasExternalComponentSnapshotLike =
	CanvasExternalComponentSnapshot;

/**
 * Module-private brand.
 *
 * `declare const` with `unique symbol`, not exported: the type is nameable from
 * outside (so signatures can require it) but a value of it is not constructible
 * from outside, because no other module can produce this symbol key.
 */
declare const validatedExternalSnapshot: unique symbol;

/**
 * A snapshot that has passed strict parsing, bounding, canonicalization, and
 * digest verification.
 *
 * Only {@link admitExternalSnapshot} can produce one. A command taking this type
 * as its input therefore cannot be called with unverified data — the guarantee is
 * enforced by the compiler, not by documentation or call ordering.
 */
export type CanvasValidatedExternalSnapshot<
	T extends
		CanvasExternalComponentSnapshotLike = CanvasExternalComponentSnapshotLike,
> = T & {
	readonly [validatedExternalSnapshot]: "canvas-validated-external-snapshot";
};

export interface AdmitExternalSnapshotOptions {
	/** Host-supplied SHA-256 verifier (TD §6.3). */
	verifier: CanvasIntegrityVerifier;
	/**
	 * Transport-reported byte length, checked **before** parsing when available
	 * (TD §23.3) so a hostile multi-megabyte body is refused without being walked.
	 */
	rawByteLength?: number;
	/** ISO timestamp recorded once as `fetchedAt`. */
	fetchedAt?: string;
	/**
	 * Already-admitted snapshots to resolve this envelope's dependencies against
	 * (plan 0021 T-017).
	 *
	 * Optional, and its absence does NOT disable closure validation — the checks
	 * that need no registry (declared-vs-actual references, fan-out, depth,
	 * expanded-node count, no local references) always run. Supplying it
	 * additionally proves the closure is *present*.
	 */
	closureResolver?: ClosureResolver;
	/** Snapshots being admitted in the same transaction (see {@link ValidateExternalClosureOptions.pending}). */
	pendingSnapshots?: readonly CanvasExternalComponentSnapshot[];
	/**
	 * Extra host-supplied graph validation, run **in addition to** the built-in
	 * closure check (T-017).
	 *
	 * Both run **after** normalization and **before** canonicalization, because a
	 * rejected graph must never reach the digest.
	 */
	validateGraph?: (
		snapshot: CanvasExternalComponentSnapshotLike,
	) => CanvasComponentDiagnostic | null;
}

export type CanvasAdmissionResult<
	T extends
		CanvasExternalComponentSnapshotLike = CanvasExternalComponentSnapshotLike,
> =
	| {
			ok: true;
			snapshot: CanvasValidatedExternalSnapshot<T>;
			/** The exact bytes that were hashed — useful for host-side caching. */
			canonicalBytes: Uint8Array;
			/** Registry key this snapshot must be stored under. */
			key: string;
	  }
	| { ok: false; diagnostic: CanvasComponentDiagnostic };

/**
 * The canonical subject: what actually gets hashed.
 *
 * Deliberately excludes, per TD §5.4/§6.2:
 * - `integrity` itself — a digest cannot cover itself;
 * - `fetchedAt` — a re-fetch of identical bytes must produce the same digest;
 * - `metadata` — catalog text is non-authoritative and changes independently.
 *
 * Includes the rest of the exact identity (`libraryId`/`componentId`/`version`), so
 * the same definition bytes published under a different identity produce a
 * different digest and cannot be substituted (TD §22.1).
 */
function canonicalSubject(
	snapshot: CanvasExternalComponentSnapshotLike,
): unknown {
	return {
		canonicalFormatVersion: snapshot.canonicalFormatVersion,
		libraryId: snapshot.ref.libraryId,
		componentId: snapshot.ref.componentId,
		version: snapshot.ref.version,
		definition: snapshot.definition,
		dependencies: snapshot.dependencies,
	};
}

function fail(diagnostic: CanvasComponentDiagnostic): {
	ok: false;
	diagnostic: CanvasComponentDiagnostic;
} {
	return { ok: false, diagnostic };
}

/**
 * Admit an untrusted envelope, or explain why not.
 *
 * Resolves a result rather than throwing: this runs in an Editor effect against a
 * network response, where every rejection is an expected outcome that the UI
 * surfaces by `code` (T-007 acceptance: "never a crash").
 *
 * Order is load-bearing — strict parse → normalize → bound/graph → canonicalize →
 * verify → brand. Verification is **last** so that nothing which failed an earlier
 * check can ever have its digest computed, and nothing that passed verification can
 * have been mutated afterwards.
 */
export async function admitExternalSnapshot(
	envelope: unknown,
	options: AdmitExternalSnapshotOptions,
): Promise<CanvasAdmissionResult> {
	// 1. Byte ceiling before parse, when the transport told us the size.
	if (
		options.rawByteLength !== undefined &&
		options.rawByteLength > MAX_EXTERNAL_ENVELOPE_BYTES
	) {
		return fail(
			componentDiagnostic(
				"component-snapshot-invalid",
				`envelope is ${options.rawByteLength.toLocaleString()} bytes, exceeding the ${MAX_EXTERNAL_ENVELOPE_BYTES.toLocaleString()} byte ceiling`,
			),
		);
	}

	// 2. Strict parse — unknown keys rejected at the trust boundary.
	const parsed = CanvasExternalComponentEnvelopeSchema.safeParse(envelope);
	if (!parsed.success) {
		return fail(
			componentDiagnostic(
				"component-snapshot-invalid",
				`envelope failed strict validation: ${parsed.error.issues
					.map(
						(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
					)
					.join("; ")}`,
			),
		);
	}

	// (M0 had an explicit `definition === undefined` guard here. It became
	// unreachable in T-014 when `definition` stopped being `z.unknown()` and
	// gained a required schema, so it was removed rather than left as a branch no
	// test could ever cover — same call made for the codec in T-005.)

	// 3. Normalize into the stored snapshot shape.
	const snapshot: CanvasExternalComponentSnapshotLike = {
		ref: parsed.data.ref,
		definition: parsed.data.definition,
		dependencies: parsed.data.dependencies,
		canonicalFormatVersion: parsed.data.canonicalFormatVersion,
		...(options.fetchedAt === undefined
			? {}
			: { fetchedAt: options.fetchedAt }),
	};

	// 4. Graph / expansion limits. The built-in closure check runs
	//    unconditionally — a caller cannot forget to bound a dependency bomb —
	//    and a host hook may add to it.
	const closureProblem = validateExternalClosure(
		snapshot,
		options.closureResolver,
		options.pendingSnapshots
			? { pending: options.pendingSnapshots }
			: {},
	);
	if (closureProblem) return fail(closureProblem);
	const graphProblem = options.validateGraph?.(snapshot);
	if (graphProblem) return fail(graphProblem);

	// 5. Key derivation. Runs before canonicalization so a reference that cannot
	//    be keyed is refused with a precise reason rather than a digest mismatch.
	let key: string;
	try {
		key = snapshotKey(snapshot.ref);
	} catch (error) {
		return fail(
			componentDiagnostic(
				"component-snapshot-invalid",
				`reference cannot be keyed: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	// 6. Canonicalize the subject.
	let canonicalBytes: Uint8Array;
	try {
		canonicalBytes = canonicalizeComponentPayload(canonicalSubject(snapshot));
	} catch (error) {
		if (error instanceof CanvasCanonicalizationError) {
			return fail(
				componentDiagnostic(
					"component-snapshot-invalid",
					`payload has no canonical form: ${error.message}`,
				),
			);
		}
		throw error;
	}

	// 7. Integrity format.
	const integrity = parseIntegrity(snapshot.ref.integrity);
	if (!integrity.ok) return fail(integrity.diagnostic);

	// 8. Verify. A rejected promise means "could not check", which is reported
	//    distinctly from "checked and did not match".
	let verified: boolean;
	try {
		verified = await options.verifier.verify({
			algorithm: CANVAS_INTEGRITY_ALGORITHM,
			canonicalBytes,
			expectedDigest: integrity.value.digest,
		});
	} catch (error) {
		return fail(
			componentDiagnostic(
				"component-integrity-mismatch",
				`integrity could not be verified: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	if (!verified) {
		return fail(
			componentDiagnostic(
				"component-integrity-mismatch",
				`canonical bytes do not match the declared ${integrity.value.algorithm} digest for ${key}`,
				{ snapshotKey: key },
			),
		);
	}

	// 9. Brand. The only place in the package this cast occurs.
	return {
		ok: true,
		snapshot: snapshot as CanvasValidatedExternalSnapshot,
		canonicalBytes,
		key,
	};
}
