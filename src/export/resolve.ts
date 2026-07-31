import type { CanvasIR } from "../ir/types.js";
import { migrateCanvasIR } from "../ir/validators.js";
import type { CanvasExportJobSource } from "./types.js";

/**
 * Resolves a {@link CanvasExportJobSource} to a validated, current-version
 * `CanvasIR` — only when it carries the document inline. A `documentRef`
 * source is a host/worker resolution concern; `canvas-core` never attempts
 * to resolve one itself and this function throws rather than guessing.
 *
 * Always routes through `migrateCanvasIR` (not a bare schema parse), so an
 * inline document authored at an older IR version still resolves correctly.
 */
export function resolveInlineExportDocument(
	source: CanvasExportJobSource,
): CanvasIR {
	if (!("document" in source)) {
		throw new Error(
			// Message clarity is T-047 step 1's whole deliverable: the old wording
			// said what canvas-core will not do, but not what the host must do
			// INSTEAD — and a worker that resolves the ref and then exports the
			// document directly satisfies the old message while skipping component
			// resolution and the compliance report entirely (AC-015).
			"CanvasExportJobSource.documentRef requires host/worker resolution before use — canvas-core does not resolve refs. " +
				"After resolving, call prepareExport({ document }, { context }) from @anvilkit/canvas-core/brand-governance rather than exporting the document directly: " +
				"the inline and worker paths must produce the same compliance report and the same allow/block outcome.",
		);
	}
	return migrateCanvasIR(source.document);
}
