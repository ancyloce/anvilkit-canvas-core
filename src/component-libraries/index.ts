/**
 * `@anvilkit/canvas-core/component-libraries` — external Component Library
 * support: canonicalization, integrity verification, the snapshot-key codec,
 * envelope admission, external resolution, and the library commands.
 *
 * ## Why this is a subpath and not part of the root barrel
 *
 * The root barrel carries an 80 KB gzipped budget (`.size-limit.json`), and
 * this domain pulls in a JSON canonicalizer, strict envelope schemas, and six
 * commands that the large majority of consumers — anyone not using external
 * libraries — never touch. Exporting it from `"."` would charge every consumer
 * for it. Plan 0021 OD-17 / D-2 resolves this with a subpath entry, which is a
 * new pattern for this package; `@anvilkit/core/config` is the workspace
 * precedent.
 *
 * The root barrel still re-exports the *types* consumers need to describe a
 * document (`CanvasExternalComponentRef` and friends) — types are erased at
 * runtime and cost nothing. Values stay here.
 *
 * ## Layering
 *
 * Rank 4 (`scripts/check-layering.mjs`), a sibling of `templates/`, `brand/`,
 * and `layout/`. It may read `ir/` (1), `components/` (2), and `commands/` (3);
 * it may not be read by any of them. In particular `ir/` cannot import the
 * snapshot-key schema from here — see `docs/architecture/src-layer-map.md`.
 */

// Re-exported from `../uri.js` (rank 0) rather than declared here: the Editor's
// Libraries panel needs it to sanitize Provider thumbnails and release-notes
// links, and this subpath is the public door to that. It stays OUT of the root
// barrel so the 80 KB root budget is untouched.
export { sanitizeProviderUrl } from "../uri.js";
export {
	type AdmitExternalSnapshotOptions,
	admitExternalSnapshot,
	CANVAS_CANONICAL_FORMAT_VERSION,
	type CanvasAdmissionResult,
	type CanvasExternalComponentCatalogMetadata,
	CanvasExternalComponentCatalogMetadataSchema,
	CanvasExternalComponentDefinitionSchema,
	type CanvasExternalComponentEnvelope,
	CanvasExternalComponentEnvelopeSchema,
	type CanvasExternalComponentSnapshotLike,
	type CanvasValidatedExternalSnapshot,
} from "./admission.js";
// Re-exported from `components/` (rank 2): the index is consumed by the
// resolver, which cannot import upward from this rank-4 domain, but it is part
// of this subpath's story so the public door stays here. See that module's
// header for why the plan's placement was not implementable.
export {
	type CanvasDefinitionLookup,
	type CanvasExternalComponentState,
	componentSourceKey,
	getDefinition,
} from "../components/definition-lookup.js";
export {
	buildExternalSnapshotIndex,
	type CanvasExternalSnapshotIndex,
} from "../components/snapshot-index.js";
export {
	type CanvasComponentDependencyRef,
	type ClosureResolver,
	type ValidateExternalClosureOptions,
	validateExternalClosure,
} from "./dependencies.js";
// ── Library commands (T-021, T-023) ─────────────────────────────────────────
// Registered through `createCanvasRuntime`'s extension seam, NOT the built-in
// command union: they carry the rank-4 branded snapshot type and `commands/`
// is rank 3. See `commands/insert-external.ts` for the full rationale.
export {
	type CanvasComponentInsertExternalCommand,
	type CanvasComponentRevertExternalInsertCommand,
	createExternalInsertCommandHandlers,
	INSERT_EXTERNAL_COMMAND,
	REVERT_EXTERNAL_INSERT_COMMAND,
} from "./commands/insert-external.js";
export {
	type CanvasComponentRecoverSnapshotCommand,
	type CanvasComponentUnrecoverSnapshotCommand,
	createSnapshotRecoveryCommandHandlers,
	RECOVER_SNAPSHOT_COMMAND,
	UNRECOVER_SNAPSHOT_COMMAND,
} from "./commands/recover-snapshot.js";
export * from "./compatibility.js";
export {
	type CanvasCollectionPreview,
	type CanvasComponentCollectUnusedCommand,
	type CanvasComponentRestoreCollectedCommand,
	COLLECT_UNUSED_COMMAND,
	createCollectUnusedCommandHandlers,
	previewCollectUnused,
	RESTORE_COLLECTED_COMMAND,
} from "./commands/collect-unused.js";
export {
	collectReferencedSnapshotKeys,
	collectUnreferencedSnapshotKeys,
} from "./reference-index.js";
export {
	type CanvasComponentRevertSourceChangeCommand,
	type CanvasComponentSwapSourceCommand,
	type CanvasComponentUpdateSourceCommand,
	createSourceChangeCommandHandlers,
	previewSourceChange,
	REVERT_SOURCE_CHANGE_COMMAND,
	SWAP_SOURCE_COMMAND,
	UPDATE_SOURCE_COMMAND,
} from "./commands/update-source.js";
export {
	type CanvasComponentSetVariantCommand,
	type CanvasVariantChangeSummary,
	type CanvasVariantOverrideOutcome,
	createSetVariantCommandHandlers,
	previewVariantChange,
	SET_VARIANT_COMMAND,
} from "./commands/set-variant.js";
export * from "./variants.js";
export {
	canonicalizeComponentPayload,
	canonicalizeComponentPayloadToString,
} from "./canonicalize.js";
export {
	CANVAS_COMPONENT_ABORTING_CODES,
	CANVAS_COMPONENT_DIAGNOSTIC_CODES,
	type CanvasComponentAbortingCode,
	type CanvasComponentDiagnostic,
	type CanvasComponentDiagnosticCode,
	type CanvasComponentDiagnosticSeverity,
	componentDiagnostic,
	componentDiagnosticSeverity,
	isCanvasComponentAbortingCode,
	isCanvasComponentDiagnosticCode,
} from "./diagnostics.js";
export {
	CanvasCanonicalizationError,
	type CanvasCanonicalizationErrorCode,
	type CanvasComponentLimitCode,
	CanvasComponentLimitError,
	CanvasSnapshotKeyError,
	type CanvasSnapshotKeyErrorCode,
	enforceLimit,
	limitFor,
} from "./errors.js";
export {
	CANVAS_INTEGRITY_ALGORITHM,
	type CanvasIntegrityAlgorithm,
	type CanvasIntegrityVerifier,
	type CanvasParsedIntegrity,
	type CanvasParseIntegrityResult,
	digestsEqual,
	formatIntegrity,
	parseIntegrity,
} from "./integrity.js";
export {
	CanvasComponentSourceRefSchema,
	CanvasExternalComponentRefSchema,
	CanvasLocalComponentSourceRefSchema,
} from "./schema.js";
export {
	boundedDisplayString,
	boundedIdentifier,
	boundedProviderUrl,
	strictEnvelopeObject,
} from "./schema-utils.js";
export {
	isSnapshotKey,
	parseSnapshotKey,
	SnapshotKeySchema,
	snapshotKey,
} from "./snapshot-key.js";
export type {
	CanvasExternalComponentSnapshot,
	CanvasExternalComponentSnapshotRegistry,
} from "./types.js";
export {
	type CanvasComponentSourceRef,
	type CanvasExternalComponentRef,
	isExternalSourceRef,
	isLocalSourceRef,
} from "./types.js";
