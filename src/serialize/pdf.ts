import { PDFDocument } from "pdf-lib";
import type { CanvasIR, CanvasPage, CanvasUnit } from "../ir/types.js";
import { CanvasIRSchema } from "../ir/validators.js";
import { DEFAULT_DPI } from "./svg.js";

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
}

export type PdfWarningCode =
	| "RASTER_MISSING"
	| "RASTER_UNSUPPORTED_MIME"
	| "RASTER_DECODE_FAILED";

export interface PdfSerializeWarning {
	code: PdfWarningCode;
	message: string;
	pageId?: string;
}

export interface PdfSerializeResult {
	pdf: Uint8Array;
	warnings: PdfSerializeWarning[];
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
