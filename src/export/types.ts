import type { CanvasIR, CanvasPageSize } from "../ir/types.js";

/**
 * The headless export job contract (PRD FR-040, §12.7).
 *
 * Naming: every type here is `CanvasExportJob*` rather than the PRD's
 * proposed bare `CanvasExportRequest`/`CanvasExportResponse`/`CanvasExportArtifact`
 * — those exact names already exist with DIFFERENT meanings in sibling
 * packages: `@anvilkit/plugin-export-canvas`'s `CanvasExportOptions`
 * (`src/types.ts:22`, per-format option bag for the Studio `exportAs`
 * pipeline) and `@anvilkit/canvas-editor`'s `CanvasExportRequest`/
 * `CanvasExportArtifact` (`src/header/types.ts`, the export popover's
 * quality/resolution/stripMetadata knobs and its downloadable-artifact
 * shape). The `Job` qualifier keeps this headless, worker-facing contract
 * unambiguous from both.
 */
export type CanvasExportFormat =
	| "svg"
	| "png"
	| "jpeg"
	| "webp"
	| "pdf"
	| "pdf-print"
	/**
	 * Raw Canvas IR as JSON (B-04, FR-151). Reconciles the vocabulary with the
	 * editor's built-in JSON exporter, which predates this entry.
	 */
	| "json";

/**
 * Where the document to export comes from. `document` carries the IR
 * inline; `documentRef` is an opaque reference a host/worker resolves —
 * `canvas-core` never attempts to resolve one itself (see
 * {@link resolveInlineExportDocument} in `./resolve.js`).
 */
export type CanvasExportJobSource =
	| { readonly document: CanvasIR }
	| { readonly documentRef: string };

/**
 * One target variant within a batch/campaign export (wiring point for
 * canvas-m3-006's `CanvasSizePreset` and canvas-m3-007's campaign resize —
 * both land after this contract, additively).
 */
export interface CanvasExportJobVariant {
	/** A `CanvasSizePreset.id` this variant targets, when preset-driven. */
	readonly presetId?: string;
	/** The specific page id/index this variant renders, when already generated. */
	readonly pageId?: string;
	readonly label?: string;
}

/**
 * Format-specific knobs for one export job. Deliberately narrower than the
 * plugin's `CanvasExportOptions`: `canvasIR`/`page` move to
 * {@link CanvasExportJobRequest.source}/`.pages` here, so they aren't
 * duplicated. `rasters` is omitted too — a raster-embedding job contract is
 * FR-043 (canvas-m3-004)'s concern, not this one's.
 */
export interface CanvasExportJobOptions extends Record<string, unknown> {
	/** Fallback DPI for unit→px/pt conversion. */
	readonly dpi?: number;
	/** Pretty-print text-based output (SVG/JSON). */
	readonly pretty?: boolean;
	/** Base filename (no extension). */
	readonly filename?: string;
	readonly pdf?: {
		readonly title?: string;
		readonly author?: string;
	};
	/** Print-oriented metadata for the `"pdf-print"` format (FR-043, canvas-m3-004). Ignored by every other format. */
	readonly print?: CanvasPrintPdfMetadata;
}

export type CanvasPrintColorMode = "rgb" | "cmyk";

export interface CanvasPrintSafeArea {
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
	readonly left: number;
}

/**
 * Print-oriented PDF metadata (FR-043, canvas-m3-004). Shared verbatim with
 * `serialize/pdf.ts`'s `PdfSerializeOptions.print` (that domain is allowed to
 * import this one — `export/` sits at a strictly lower layer rank) so the
 * job-contract metadata and the actual print-safety check never drift apart.
 *
 * Raster PDF (`serializeDocumentToPdf`) remains the only EXECUTABLE path —
 * `capabilities.vector` records that true vector PDF is a documented future
 * capability, not something this task implements.
 */
export interface CanvasPrintPdfMetadata {
	readonly pageSize?: CanvasPageSize;
	/** Bleed distance, in `pageSize.unit`. */
	readonly bleed?: number;
	/** Margin distance, in `pageSize.unit`. */
	readonly margin?: number;
	/**
	 * Target DPI for this print job. Doubles as the minimum acceptable DPI for
	 * embedded rasters — `serializeDocumentToPdf` warns with `PRINT_UNSAFE`
	 * when an embedded raster's effective DPI falls below it. Defaults to 150
	 * (a common print-safety floor) when `print` is present but `dpi` is not.
	 */
	readonly dpi?: number;
	/**
	 * Advisory only — `canvas-core` does not introspect an embedded raster's
	 * color profile, so a `"cmyk"`-flagged job never actually verifies the
	 * source is CMYK. Surfaced so a host/print vendor can act on the intent.
	 */
	readonly colorMode?: CanvasPrintColorMode;
	readonly safeArea?: CanvasPrintSafeArea;
	readonly capabilities: {
		readonly raster: true;
		/** Always `false` today — no vector PDF renderer exists yet. */
		readonly vector: boolean;
	};
}

export interface CanvasExportJobRequest {
	readonly id: string;
	readonly source: CanvasExportJobSource;
	readonly format: CanvasExportFormat;
	/** Page ids/indices to include. Single-page formats use the first entry; omitted means "all pages". */
	readonly pages?: ReadonlyArray<string | number>;
	/** Multi-size/campaign batch targets (FR-061). Omitted for a plain single-document export. */
	readonly variants?: readonly CanvasExportJobVariant[];
	readonly options: CanvasExportJobOptions;
}

export type CanvasExportJobStatus = "success" | "partial" | "failed";

/** One produced file. `data` stays `string | Uint8Array` — no base64 round-tripping (matches `@anvilkit/contracts`' `ExportResult` convention). */
export interface CanvasExportJobArtifact {
	readonly filename: string;
	readonly data: string | Uint8Array;
	readonly mimeType: string;
	/** Which page/variant this artifact corresponds to, for batch exports. */
	readonly pageId?: string;
	readonly variantLabel?: string;
}

export type CanvasExportWarningLevel = "info" | "warn" | "error";

/**
 * A unified, format-agnostic export warning (FR-041, canvas-m3-002). `code`
 * is a plain string rather than a closed union: a single job may touch
 * SVG-specific (`SvgWarningCode`) or PDF-specific (`PdfWarningCode`) codes
 * depending on `format`, and this shape must not force every new per-format
 * code to widen a shared enum. Adapters that serialize via
 * `serializePageToSvg`/`serializeDocumentToPdf` map those functions' own
 * typed warnings into this shape 1:1 (`code` carries the same string value).
 */
export interface CanvasExportWarning {
	readonly level: CanvasExportWarningLevel;
	readonly code: string;
	readonly message: string;
	readonly nodeId?: string;
	readonly pageId?: string;
	/** Optional suggested remediation, mirrored from `SvgSerializeWarning.fallback`/`PdfSerializeWarning.fallback` (FR-041, canvas-m3-002). */
	readonly fallback?: string;
}

export type CanvasExportFidelityGrade =
	| "exact"
	| "high"
	| "medium"
	| "low"
	| "unsupported";

export interface CanvasExportFidelity {
	readonly grade: CanvasExportFidelityGrade;
	/** 0-100. */
	readonly score: number;
	readonly reasons?: readonly string[];
}

export interface CanvasExportJobResponse {
	readonly id: string;
	readonly status: CanvasExportJobStatus;
	readonly artifacts: readonly CanvasExportJobArtifact[];
	readonly warnings: readonly CanvasExportWarning[];
	readonly fidelity?: CanvasExportFidelity;
	/** Maps a logical page/variant key to the artifact filenames produced for it. */
	readonly pageMapping?: Readonly<Record<string, readonly string[]>>;
}
