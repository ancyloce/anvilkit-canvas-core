import { PDFDocument } from "pdf-lib";
import type { CanvasPrintPdfMetadata } from "../export/types.js";
import type { CanvasIR, CanvasPage, CanvasUnit } from "../ir/types.js";
import { CanvasIRSchema } from "../ir/validators.js";
import { walkPage } from "../ir/walkers.js";
import { DEFAULT_DPI } from "./svg.js";

/** Fallback minimum DPI for the print-safety check when `print.dpi` is unset. */
const DEFAULT_PRINT_MIN_DPI = 150;

/**
 * Raster-embed PDF serializer for `@anvilkit/canvas-core`.
 *
 * This package is headless — it must never import React or Konva (nor
 * `@anvilkit/core` / `@anvilkit/plugin-asset-manager`). It therefore cannot
 * rasterize a live Konva stage itself; the caller renders each page to a PNG/JPEG
 * (e.g. via `@anvilkit/canvas-editor`'s `rasterizePage` → `stage.toDataURL`) and
 * passes the bytes in through {@link PdfSerializeOptions.rasters}.
 *
 * The output is a multi-page PDF — one PDF page per selected {@link CanvasPage},
 * sized to the page's physical dimensions (points), with its raster drawn to fill
 * the page. Per-page degradations (missing/undecodable/unsupported raster) are
 * reported in `warnings` rather than thrown; the corresponding page is left blank.
 *
 * Vector PDF is intentionally out of scope (see plan §4 / PRD §1.6) — every page
 * is a rasterized screenshot, so text is not selectable and shapes are not vector.
 * FR-043 (canvas-m3-004) added the print-metadata contract + a print-SAFETY
 * check (`options.print`, `PRINT_UNSAFE` warnings) on top of this raster path;
 * true vector PDF stays a documented future capability
 * (`CanvasPrintPdfMetadata.capabilities.vector`), not implemented here.
 *
 * FRAMES: this serializer needs no frame-specific code. Because it embeds a raster
 * the CALLER produced, frame clipping/backgrounds are already baked into those
 * pixels by the editor's rasterizer (Konva applies the frame's clip when drawing
 * the stage — see canvas-m1-004). The SVG path is where frames are represented
 * structurally (`<clipPath>`, see `emitFrame` in `./svg.ts`); the PDF path simply
 * inherits whatever the rasterizer drew. A frame is therefore never separately
 * flattened or dropped here.
 */

// --- units -------------------------------------------------------------------

/** PostScript points per inch — the PDF user-space unit. */
const PT_PER_INCH = 72;
const MM_PER_INCH = 25.4;

/**
 * Convert a page dimension to PDF points. `in`/`mm` are physical; `px` is scaled
 * through `dpi` so a screen-pixel page maps to a sensible physical size. Mirrors
 * the unit semantics of `unitToPx` in `./svg.ts` (which shares {@link DEFAULT_DPI}).
 */
export function unitToPt(value: number, unit: CanvasUnit, dpi: number): number {
	switch (unit) {
		case "in":
			return value * PT_PER_INCH;
		case "mm":
			return (value / MM_PER_INCH) * PT_PER_INCH;
		default:
			return (value / dpi) * PT_PER_INCH;
	}
}

// --- raster decoding ---------------------------------------------------------

export type PdfRasterMimeType = "image/png" | "image/jpeg";

/** A `data:image/(png|jpeg);base64,…` URL accepted by {@link PdfRasterPage}. */
const DATA_URL_RE = /^data:(image\/(?:png|jpe?g));base64,([\s\S]*)$/i;

/** Normalize a MIME string to a pdf-lib-embeddable type, or `undefined`. */
function normalizeMime(mime: string): PdfRasterMimeType | undefined {
	const lower = mime.trim().toLowerCase();
	if (lower === "image/png") return "image/png";
	if (lower === "image/jpeg" || lower === "image/jpg") return "image/jpeg";
	return undefined;
}

/**
 * Decode a base64 string to bytes. Mirrors the environment detection in
 * `bytesToBase64` (`./svg.ts`): Node `Buffer` when present, else `atob`.
 */
function base64ToBytes(base64: string): Uint8Array {
	const bufferCtor = (
		globalThis as typeof globalThis & {
			Buffer?: { from(data: string, encoding: string): Uint8Array };
		}
	).Buffer;

	if (bufferCtor) {
		return new Uint8Array(bufferCtor.from(base64, "base64"));
	}

	if (typeof atob !== "function") {
		throw new Error("Base64 decoding is not supported in this environment.");
	}

	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

type DecodedRaster =
	| { ok: true; bytes: Uint8Array; mime: PdfRasterMimeType }
	| {
			ok: false;
			code: "RASTER_UNSUPPORTED_MIME" | "RASTER_DECODE_FAILED";
			message: string;
	  };

function decodeRaster(raster: PdfRasterPage): DecodedRaster {
	const { image, mimeType } = raster;

	if (image instanceof Uint8Array) {
		const mime = normalizeMime(mimeType ?? "image/png");
		if (!mime) {
			return {
				ok: false,
				code: "RASTER_UNSUPPORTED_MIME",
				message: `Unsupported raster MIME "${mimeType}" (expected image/png or image/jpeg).`,
			};
		}
		if (image.byteLength === 0) {
			return {
				ok: false,
				code: "RASTER_DECODE_FAILED",
				message: "Raster image bytes are empty.",
			};
		}
		return { ok: true, bytes: image, mime };
	}

	const match = DATA_URL_RE.exec(image.trim());
	const rawMime = match?.[1];
	const payload = match?.[2];
	if (rawMime === undefined || payload === undefined) {
		return {
			ok: false,
			code: "RASTER_UNSUPPORTED_MIME",
			message:
				"Raster string must be a base64 data: URL of type image/png or image/jpeg.",
		};
	}

	// `mime` is guaranteed valid by the regex's MIME alternation.
	const mime = normalizeMime(rawMime) as PdfRasterMimeType;
	try {
		const bytes = base64ToBytes(payload);
		if (bytes.byteLength === 0) {
			return {
				ok: false,
				code: "RASTER_DECODE_FAILED",
				message: "Decoded raster image is empty.",
			};
		}
		return { ok: true, bytes, mime };
	} catch (error) {
		return {
			ok: false,
			code: "RASTER_DECODE_FAILED",
			message: `Failed to decode base64 raster: ${(error as Error).message}`,
		};
	}
}

// --- page resolution ---------------------------------------------------------

/**
 * Resolve a page by id (string) or index (number). Replicates the private
 * `resolvePage` in `./svg.ts` so this module stays self-contained; an unknown
 * selector throws.
 */
function resolvePage(ir: CanvasIR, selector: string | number): CanvasPage {
	if (typeof selector === "number") {
		const page = ir.pages[selector];
		if (!page) {
			throw new RangeError(
				`Canvas page index ${selector} is out of range (pages: ${ir.pages.length}).`,
			);
		}
		return page;
	}
	const page = ir.pages.find((candidate) => candidate.id === selector);
	if (!page) {
		throw new Error(`Canvas page with id "${selector}" was not found.`);
	}
	return page;
}

function resolvePages(
	ir: CanvasIR,
	selectors?: ReadonlyArray<string | number>,
): CanvasPage[] {
	if (!selectors) return [...ir.pages];
	return selectors.map((selector) => resolvePage(ir, selector));
}

// --- public API --------------------------------------------------------------

export interface PdfRasterPage {
	/** Matches a {@link CanvasPage.id} in the IR. */
	pageId: string;
	/**
	 * The rendered page screenshot: raw PNG/JPEG bytes, or a
	 * `data:image/(png|jpeg);base64,…` URL.
	 */
	image: Uint8Array | string;
	/**
	 * MIME of `image` when it is raw bytes. Defaults to `image/png`. Ignored when
	 * `image` is a data URL (the URL's declared type wins).
	 */
	mimeType?: PdfRasterMimeType;
}

export interface PdfSerializeOptions {
	/** Pre-rendered page rasters. A selected page with no matching entry is blank. */
	rasters: PdfRasterPage[];
	/**
	 * Pages to emit, by id or index, in order. Defaults to every page in IR order.
	 * An unknown selector throws; an explicitly empty list throws (no PDF pages).
	 */
	pages?: Array<string | number>;
	/** Fallback px→pt DPI when a page omits `size.dpi`. Defaults to {@link DEFAULT_DPI}. */
	dpi?: number;
	/** Written to the PDF document's title metadata. */
	title?: string;
	/** Written to the PDF document's author metadata. */
	author?: string;
	/**
	 * Run {@link CanvasIRSchema} over `ir` before emitting and throw on failure
	 * (default `false`). Independently of this flag, a page whose computed
	 * dimensions are non-finite throws a `RangeError` rather than producing a
	 * corrupt PDF (`pdf-lib` would otherwise receive `NaN` page bounds).
	 */
	validate?: boolean;
	/**
	 * Print-safety metadata (FR-043, canvas-m3-004). When present, every
	 * successfully-embedded raster's EFFECTIVE dpi (its natural pixel size
	 * divided by the page's print size in inches) is compared against
	 * `print.dpi` (default 150 DPI); a raster below it
	 * warns with `PRINT_UNSAFE` rather than failing the export. `colorMode` is
	 * advisory only — see {@link CanvasPrintPdfMetadata.colorMode}.
	 */
	print?: CanvasPrintPdfMetadata;
}

export type PdfWarningCode =
	| "RASTER_MISSING"
	| "RASTER_UNSUPPORTED_MIME"
	| "RASTER_DECODE_FAILED"
	// Added for the print PDF contract (FR-043, canvas-m3-004). Fires when an
	// asset used in a `"pdf-print"` job falls below print-safe quality (e.g. a
	// low-DPI raster, or an RGB-only source for a CMYK-flagged job) — the
	// grow-only rule (FR-041) applies here too.
	| "PRINT_UNSAFE"
	// Added for animation metadata (FR-080, canvas-m6-001). Fires whenever a
	// page carries `animation` metadata — PDF embeds a pre-rasterized page
	// image (no per-node visibility), so this is necessarily page-scoped,
	// unlike SVG's per-node `ANIMATION_IGNORED`.
	| "ANIMATION_IGNORED"
	// Added for video/audio nodes (FR-081, canvas-m6-002). Fires once per page
	// that contains at least one video/audio node — the supplied raster is
	// whatever the caller already rendered (typically via the SVG path, which
	// applies its own poster/no-op fallback), so PDF's role is only to flag
	// that this page contains media a static document can't play.
	| "VIDEO_UNSUPPORTED"
	| "AUDIO_UNSUPPORTED";

export interface PdfSerializeWarning {
	code: PdfWarningCode;
	message: string;
	pageId?: string;
	/** Optional suggested remediation (FR-041, canvas-m3-002). Additive, matches `SvgSerializeWarning.fallback`. */
	fallback?: string;
}

export interface PdfSerializeResult {
	pdf: Uint8Array;
	warnings: PdfSerializeWarning[];
}

/**
 * Every `video`/`audio` node kind present on `page`, deduped — used to emit at
 * most one `VIDEO_UNSUPPORTED`/`AUDIO_UNSUPPORTED` warning per page regardless
 * of how many media nodes it contains (FR-081, canvas-m6-002).
 */
function findMediaKindsOnPage(
	page: CanvasPage,
): ReadonlySet<"video" | "audio"> {
	const kinds = new Set<"video" | "audio">();
	walkPage(page, ({ node }) => {
		if (node.type === "video" || node.type === "audio") kinds.add(node.type);
	});
	return kinds;
}

/**
 * Serialize a {@link CanvasIR} document to a multi-page PDF, one PDF page per
 * selected {@link CanvasPage}, with each page's pre-rendered raster drawn to fill
 * it. Page count always equals the number of selected pages; pages whose raster
 * is missing/undecodable/unsupported are emitted blank with a corresponding entry
 * in `warnings`.
 *
 * Throws a `RangeError` when there are no pages to render (empty document, or a
 * `pages` list that resolves to nothing) since a PDF requires at least one page.
 */
export async function serializeDocumentToPdf(
	ir: CanvasIR,
	options: PdfSerializeOptions,
): Promise<PdfSerializeResult> {
	if (options.validate) CanvasIRSchema.parse(ir);
	const pages = resolvePages(ir, options.pages);
	if (pages.length === 0) {
		throw new RangeError(
			"serializeDocumentToPdf: no pages to render (the document is empty or `pages` selected none).",
		);
	}

	const warnings: PdfSerializeWarning[] = [];
	const fallbackDpi = options.dpi ?? DEFAULT_DPI;

	// Index rasters by page id (last entry wins on duplicate ids).
	const rastersByPage = new Map<string, PdfRasterPage>();
	for (const raster of options.rasters) {
		rastersByPage.set(raster.pageId, raster);
	}

	const doc = await PDFDocument.create();
	if (options.title !== undefined) doc.setTitle(options.title);
	if (options.author !== undefined) doc.setAuthor(options.author);

	for (const page of pages) {
		const dpi = page.size.dpi ?? fallbackDpi;
		const widthPt = unitToPt(page.size.width, page.size.unit, dpi);
		const heightPt = unitToPt(page.size.height, page.size.unit, dpi);
		if (!Number.isFinite(widthPt) || !Number.isFinite(heightPt)) {
			throw new RangeError(
				`serializeDocumentToPdf: page "${page.id}" has non-finite dimensions (${widthPt}×${heightPt} pt); the source page size is invalid.`,
			);
		}
		const pdfPage = doc.addPage([widthPt, heightPt]);

		if (page.animation) {
			warnings.push({
				code: "ANIMATION_IGNORED",
				message: `Page "${page.id}" has animation metadata ("${page.animation.kind}") that is not represented in this static export.`,
				pageId: page.id,
			});
		}
		for (const kind of findMediaKindsOnPage(page)) {
			warnings.push({
				code: kind === "video" ? "VIDEO_UNSUPPORTED" : "AUDIO_UNSUPPORTED",
				message: `Page "${page.id}" contains a ${kind} node, which cannot be played in a static PDF.`,
				pageId: page.id,
			});
		}

		const raster = rastersByPage.get(page.id);
		if (!raster) {
			warnings.push({
				code: "RASTER_MISSING",
				message: `No raster supplied for page "${page.id}"; emitted a blank page.`,
				pageId: page.id,
			});
			continue;
		}

		const decoded = decodeRaster(raster);
		if (!decoded.ok) {
			warnings.push({
				code: decoded.code,
				message: decoded.message,
				pageId: page.id,
			});
			continue;
		}

		try {
			const embedded =
				decoded.mime === "image/jpeg"
					? await doc.embedJpg(decoded.bytes)
					: await doc.embedPng(decoded.bytes);
			pdfPage.drawImage(embedded, {
				x: 0,
				y: 0,
				width: widthPt,
				height: heightPt,
			});
			if (options.print) {
				const minDpi = options.print.dpi ?? DEFAULT_PRINT_MIN_DPI;
				const widthInches = widthPt / 72;
				const effectiveDpi = widthInches > 0 ? embedded.width / widthInches : 0;
				if (effectiveDpi < minDpi) {
					warnings.push({
						code: "PRINT_UNSAFE",
						message: `Raster for page "${page.id}" is ~${Math.round(effectiveDpi)} DPI, below the print-safe minimum of ${minDpi} DPI.`,
						pageId: page.id,
						fallback: "Re-export at a higher resolution before printing.",
					});
				}
			}
		} catch (error) {
			warnings.push({
				code: "RASTER_DECODE_FAILED",
				message: `Failed to embed raster for page "${page.id}": ${(error as Error).message}`,
				pageId: page.id,
			});
		}
	}

	const pdf = await doc.save();
	return { pdf, warnings };
}
