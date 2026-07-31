/**
 * `@anvilkit/canvas-core/export-preparation` — the governed export pipeline
 * (plan 0021 T-046/T-051).
 *
 * ## Why this is its own entry and not part of `/brand-governance`
 *
 * It was part of it, and that was measurably wrong. `prepareExport` resolves
 * every component Source and validates the graph, so it pulls the whole
 * rank-2 resolver (`components/validate.ts`, `snapshot-index.ts`,
 * `definition-lookup.ts`) into whatever entry contains it. That took
 * `/brand-governance` from 4,960 to 12,281 gzipped bytes — 99.9% of its 12 KB
 * budget, with seven bytes to spare.
 *
 * The budget was not the problem; the packaging was. A host that enforces brand
 * policy at command time — the common case, and the one the subpath exists to
 * serve cheaply — never calls `prepareExport`, and should not carry the
 * resolver for it. Splitting restores that entry to 40% and gives the export
 * pipeline a budget that reflects what it actually costs.
 *
 * The alternative was raising the 12 KB limit, which would have hidden a real
 * packaging regression behind a bigger number.
 *
 * Types re-exported here are erased, so importing this module for
 * `CanvasExportPreparation` alone costs nothing at runtime.
 */

export type {
	CanvasExportPreparation,
	CanvasExportPreparationErrorCode,
	CanvasExportPreparationFailure,
	CanvasExportPreparationOptions,
	CanvasExportPreparationSuccess,
} from "./brand-governance/prepare-export.js";
export { prepareExport } from "./brand-governance/prepare-export.js";
