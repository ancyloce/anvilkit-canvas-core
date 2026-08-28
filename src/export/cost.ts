import type { CanvasPage } from "../ir/types.js";
import type { CanvasExportFormat } from "./types.js";

/** One RGBA working buffer byte estimate per output pixel. */
export const DEFAULT_EXPORT_BYTES_PER_PIXEL = 4;

/** Jobs at or below this total raster cost are suitable for an interactive path. */
export const DEFAULT_EXPORT_MAIN_THREAD_PIXEL_BUDGET = 16_000_000;

/** Jobs above this total raster cost should be routed to a server-side path. */
export const DEFAULT_EXPORT_BACKGROUND_PIXEL_BUDGET = 256_000_000;

/** Secure browser-export ceilings from PLAN-0039 E2-T2. */
export const DEFAULT_CANVAS_EXPORT_LIMITS = {
	maxOutputEdge: 8_192,
	maxPixelsPerPage: 64_000_000,
	maxTotalPixels: 256_000_000,
	maxPages: 100,
	maxScale: 4,
} as const satisfies CanvasExportLimits;

/** A neutral routing recommendation; capability checks still decide the actual executor. */
export type CanvasExportExecutionTier = "main-thread" | "background" | "server";

/** Independent output scaling for one page. */
export interface CanvasExportPixelRatio {
	readonly x: number;
	readonly y: number;
}

export interface CanvasExportCostPage {
	readonly pageId: string;
	readonly outputWidth: number;
	readonly outputHeight: number;
	readonly outputEdge: number;
	/** Raw raster pixels allocated for this page; zero for vector/data output. */
	readonly pixels: number;
	readonly estimatedMemoryBytes: number;
}

export interface CanvasExportCostEstimate {
	readonly format: CanvasExportFormat;
	readonly pageCount: number;
	readonly pages: readonly CanvasExportCostPage[];
	readonly maxOutputEdge: number;
	readonly maxPixelsPerPage: number;
	readonly totalPixels: number;
	/** Conservative total raw RGBA working memory across the requested pages. */
	readonly estimatedMemoryBytes: number;
	/** Raw RGBA working memory for the largest single page. */
	readonly estimatedPeakPageMemoryBytes: number;
	readonly likelyExecutionTier: CanvasExportExecutionTier;
}

export interface CanvasExportCostEstimatorInput {
	readonly format: CanvasExportFormat;
	/** Concrete pages after resolving current/all/pages/selection scope. */
	readonly pages: readonly CanvasPage[];
	/** Default output ratio. Defaults to 1×1. */
	readonly pixelRatio?: number | CanvasExportPixelRatio;
	/** Optional per-page overrides, used by custom-width/custom-height exports. */
	readonly pixelRatios?: Readonly<
		Record<string, number | CanvasExportPixelRatio>
	>;
	readonly bytesPerPixel?: number;
	readonly mainThreadPixelBudget?: number;
	readonly backgroundPixelBudget?: number;
}

export interface CanvasExportLimits {
	readonly maxOutputEdge: number;
	readonly maxPixelsPerPage: number;
	readonly maxTotalPixels: number;
	readonly maxPages: number;
	readonly maxScale: number;
}

export type CanvasExportLimitOverrides = Partial<CanvasExportLimits>;

export type CanvasExportLimitCode =
	| "EXPORT_SCALE_LIMIT"
	| "EXPORT_PAGE_COUNT_LIMIT"
	| "EXPORT_EDGE_LIMIT"
	| "EXPORT_PAGE_PIXELS_LIMIT"
	| "EXPORT_TOTAL_PIXELS_LIMIT";

export interface CanvasExportLimitViolation {
	readonly code: CanvasExportLimitCode;
	readonly observed: number;
	readonly limit: number;
	readonly message: string;
	readonly safeAction: string;
	readonly pageId?: string;
}

export interface CanvasExportLimitCheckInput {
	readonly estimate: CanvasExportCostEstimate;
	readonly requestedScale?: number;
	readonly limits?: CanvasExportLimitOverrides;
}

export type CanvasExportLimitCheck =
	| {
			readonly ok: true;
			readonly estimate: CanvasExportCostEstimate;
			readonly limits: CanvasExportLimits;
	  }
	| {
			readonly ok: false;
			readonly estimate: CanvasExportCostEstimate;
			readonly limits: CanvasExportLimits;
			readonly violations: readonly CanvasExportLimitViolation[];
	  };

export class CanvasExportLimitError extends Error {
	readonly code = "CANVAS_EXPORT_BUDGET_EXCEEDED" as const;
	readonly estimate: CanvasExportCostEstimate;
	readonly limits: CanvasExportLimits;
	readonly violations: readonly CanvasExportLimitViolation[];

	constructor(result: Extract<CanvasExportLimitCheck, { readonly ok: false }>) {
		const primary = result.violations[0];
		const cost = `${result.estimate.pageCount} page(s), ${megapixels(result.estimate.totalPixels)} MP total, ${megabytes(result.estimate.estimatedMemoryBytes)} MB estimated raw memory`;
		super(
			primary
				? `${primary.message} Estimated export cost: ${cost}. ${primary.safeAction}`
				: `Export exceeds its configured resource policy. Estimated export cost: ${cost}. Reduce the requested output size.`,
		);
		this.name = "CanvasExportLimitError";
		this.estimate = result.estimate;
		this.limits = result.limits;
		this.violations = result.violations;
	}
}

const RASTERIZED_FORMATS: ReadonlySet<CanvasExportFormat> = new Set([
	"png",
	"jpeg",
	"webp",
	"pdf",
	"pdf-print",
]);

function normalizeRatio(
	value: number | CanvasExportPixelRatio | undefined,
): CanvasExportPixelRatio {
	const ratio =
		typeof value === "number"
			? { x: value, y: value }
			: (value ?? { x: 1, y: 1 });
	if (
		!Number.isFinite(ratio.x) ||
		!Number.isFinite(ratio.y) ||
		ratio.x <= 0 ||
		ratio.y <= 0
	) {
		throw new RangeError(
			"Export pixel ratios must be finite and greater than zero.",
		);
	}
	return ratio;
}

function positiveFinite(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${label} must be finite and greater than zero.`);
	}
	return value;
}

function positiveInteger(value: number, label: string): number {
	positiveFinite(value, label);
	if (!Number.isInteger(value)) {
		throw new RangeError(`${label} must be an integer.`);
	}
	return value;
}

function megapixels(pixels: number): string {
	return (pixels / 1_000_000).toFixed(2);
}

function megabytes(bytes: number): string {
	return (bytes / 1_000_000).toFixed(2);
}

function outputDimension(value: number, ratio: number): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(
			"Export page dimensions must be finite and greater than or equal to zero.",
		);
	}
	return Math.ceil(value * ratio);
}

/**
 * Calculate the allocation-driving cost of an export before any canvas exists.
 *
 * Callers pass the already-resolved page scope and the exact pixel ratios the
 * renderer will use. Raster/PDF formats account for raw pixel allocations;
 * SVG and JSON still report page geometry/count but consume zero raster pixels.
 */
export function estimateCanvasExportCost(
	input: CanvasExportCostEstimatorInput,
): CanvasExportCostEstimate {
	const bytesPerPixel = positiveFinite(
		input.bytesPerPixel ?? DEFAULT_EXPORT_BYTES_PER_PIXEL,
		"bytesPerPixel",
	);
	const mainThreadPixelBudget = positiveFinite(
		input.mainThreadPixelBudget ?? DEFAULT_EXPORT_MAIN_THREAD_PIXEL_BUDGET,
		"mainThreadPixelBudget",
	);
	const backgroundPixelBudget = positiveFinite(
		input.backgroundPixelBudget ?? DEFAULT_EXPORT_BACKGROUND_PIXEL_BUDGET,
		"backgroundPixelBudget",
	);
	if (backgroundPixelBudget < mainThreadPixelBudget) {
		throw new RangeError(
			"backgroundPixelBudget must be greater than or equal to mainThreadPixelBudget.",
		);
	}

	const rasterized = RASTERIZED_FORMATS.has(input.format);
	const defaultRatio = normalizeRatio(input.pixelRatio);
	const pages = input.pages.map((page): CanvasExportCostPage => {
		const ratio = rasterized
			? normalizeRatio(input.pixelRatios?.[page.id] ?? defaultRatio)
			: { x: 1, y: 1 };
		const outputWidth = outputDimension(page.size.width, ratio.x);
		const outputHeight = outputDimension(page.size.height, ratio.y);
		const pixels = rasterized ? outputWidth * outputHeight : 0;
		return {
			pageId: page.id,
			outputWidth,
			outputHeight,
			outputEdge: Math.max(outputWidth, outputHeight),
			pixels,
			estimatedMemoryBytes: pixels * bytesPerPixel,
		};
	});

	let maxOutputEdge = 0;
	let maxPixelsPerPage = 0;
	let totalPixels = 0;
	for (const page of pages) {
		maxOutputEdge = Math.max(maxOutputEdge, page.outputEdge);
		maxPixelsPerPage = Math.max(maxPixelsPerPage, page.pixels);
		totalPixels += page.pixels;
	}

	const likelyExecutionTier: CanvasExportExecutionTier =
		totalPixels <= mainThreadPixelBudget
			? "main-thread"
			: totalPixels <= backgroundPixelBudget
				? "background"
				: "server";

	return {
		format: input.format,
		pageCount: pages.length,
		pages,
		maxOutputEdge,
		maxPixelsPerPage,
		totalPixels,
		estimatedMemoryBytes: totalPixels * bytesPerPixel,
		estimatedPeakPageMemoryBytes: maxPixelsPerPage * bytesPerPixel,
		likelyExecutionTier,
	};
}

/** Merge host overrides with the secure defaults and validate the policy. */
export function resolveCanvasExportLimits(
	overrides: CanvasExportLimitOverrides = {},
): CanvasExportLimits {
	return {
		maxOutputEdge: positiveFinite(
			overrides.maxOutputEdge ?? DEFAULT_CANVAS_EXPORT_LIMITS.maxOutputEdge,
			"maxOutputEdge",
		),
		maxPixelsPerPage: positiveFinite(
			overrides.maxPixelsPerPage ??
				DEFAULT_CANVAS_EXPORT_LIMITS.maxPixelsPerPage,
			"maxPixelsPerPage",
		),
		maxTotalPixels: positiveFinite(
			overrides.maxTotalPixels ?? DEFAULT_CANVAS_EXPORT_LIMITS.maxTotalPixels,
			"maxTotalPixels",
		),
		maxPages: positiveInteger(
			overrides.maxPages ?? DEFAULT_CANVAS_EXPORT_LIMITS.maxPages,
			"maxPages",
		),
		maxScale: positiveFinite(
			overrides.maxScale ?? DEFAULT_CANVAS_EXPORT_LIMITS.maxScale,
			"maxScale",
		),
	};
}

/** Return every exceeded factor in deterministic correction order. */
export function checkCanvasExportLimits(
	input: CanvasExportLimitCheckInput,
): CanvasExportLimitCheck {
	const limits = resolveCanvasExportLimits(input.limits);
	const requestedScale = positiveFinite(
		input.requestedScale ?? 1,
		"requestedScale",
	);
	const violations: CanvasExportLimitViolation[] = [];

	if (requestedScale > limits.maxScale) {
		violations.push({
			code: "EXPORT_SCALE_LIMIT",
			observed: requestedScale,
			limit: limits.maxScale,
			message: `Requested export scale ${requestedScale}× exceeds the ${limits.maxScale}× limit.`,
			safeAction: `Reduce scale to ${limits.maxScale}× or less.`,
		});
	}
	if (input.estimate.pageCount > limits.maxPages) {
		violations.push({
			code: "EXPORT_PAGE_COUNT_LIMIT",
			observed: input.estimate.pageCount,
			limit: limits.maxPages,
			message: `Export contains ${input.estimate.pageCount} pages, above the ${limits.maxPages}-page limit.`,
			safeAction: `Export at most ${limits.maxPages} pages at a time.`,
		});
	}

	const edgePage = input.estimate.pages.find(
		(page) => page.pixels > 0 && page.outputEdge > limits.maxOutputEdge,
	);
	if (edgePage) {
		violations.push({
			code: "EXPORT_EDGE_LIMIT",
			observed: edgePage.outputEdge,
			limit: limits.maxOutputEdge,
			pageId: edgePage.pageId,
			message: `Page "${edgePage.pageId}" has a ${edgePage.outputEdge}px output edge, above the ${limits.maxOutputEdge}px limit.`,
			safeAction: "Reduce the export scale or custom output dimensions.",
		});
	}

	const pixelPage = input.estimate.pages.find(
		(page) => page.pixels > limits.maxPixelsPerPage,
	);
	if (pixelPage) {
		violations.push({
			code: "EXPORT_PAGE_PIXELS_LIMIT",
			observed: pixelPage.pixels,
			limit: limits.maxPixelsPerPage,
			pageId: pixelPage.pageId,
			message: `Page "${pixelPage.pageId}" costs ${megapixels(pixelPage.pixels)} MP, above the ${megapixels(limits.maxPixelsPerPage)} MP per-page limit.`,
			safeAction:
				"Reduce the export scale or split the design into smaller pages.",
		});
	}
	if (input.estimate.totalPixels > limits.maxTotalPixels) {
		violations.push({
			code: "EXPORT_TOTAL_PIXELS_LIMIT",
			observed: input.estimate.totalPixels,
			limit: limits.maxTotalPixels,
			message: `Export costs ${megapixels(input.estimate.totalPixels)} MP total, above the ${megapixels(limits.maxTotalPixels)} MP job limit.`,
			safeAction: "Export fewer pages at once or reduce the export scale.",
		});
	}

	return violations.length === 0
		? { ok: true, estimate: input.estimate, limits }
		: { ok: false, estimate: input.estimate, limits, violations };
}

/** Throw a structured error before any high-cost canvas allocation. */
export function assertCanvasExportWithinLimits(
	input: CanvasExportLimitCheckInput,
): CanvasExportCostEstimate {
	const result = checkCanvasExportLimits(input);
	if (!result.ok) throw new CanvasExportLimitError(result);
	return result.estimate;
}
