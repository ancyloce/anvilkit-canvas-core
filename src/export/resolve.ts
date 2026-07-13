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
			"CanvasExportJobSource.documentRef requires host/worker resolution before use — canvas-core does not resolve refs.",
		);
	}
	return migrateCanvasIR(source.document);
}
