import type {
	CanvasExportWarning,
	CanvasPrintPdfMetadata,
} from "./export/types.js";
import {
	type AffineMatrix,
	matrixBoundsExtent,
	multiplyMatrix,
	toAffineMatrix,
} from "./geometry/affine.js";
import { resolveNodeEffects } from "./ir/effects.js";
import type {
	CanvasFontFamily,
	CanvasImageNode,
	CanvasInsets,
	CanvasIR,
	CanvasNode,
	CanvasPage,
} from "./ir/types.js";
import { isContainerNode } from "./ir/walkers.js";
import { DEFAULT_RICH_TEXT_STYLE } from "./text-contracts.js";

/** Advisory floor used by both preflight and the PDF raster-embed check. */
export const DEFAULT_PRINT_MIN_DPI = 150;
/** Common 1/8-inch print bleed, converted into each page's own unit. */
export const DEFAULT_PRINT_BLEED_INCHES = 0.125;
/** Conservative 1/4-inch content margin, converted per page. */
export const DEFAULT_PRINT_MARGIN_INCHES = 0.25;

export type CanvasPrintPreflightCode =
	| "PRINT_PAGE_DPI_LOW"
	| "PRINT_BLEED_INSUFFICIENT"
	| "PRINT_MARGIN_INSUFFICIENT"
	| "PRINT_CONTENT_OUTSIDE_SAFE_AREA"
	| "PRINT_IMAGE_RESOLUTION_LOW"
	| "PRINT_IMAGE_DIMENSIONS_UNKNOWN"
	| "PRINT_FONT_MISSING"
	| "PRINT_FONT_UNRESOLVED"
	| "PRINT_EFFECT_UNSUPPORTED";

/** A print finding uses the shared export-warning shape without a remap. */
export interface CanvasPrintPreflightIssue extends CanvasExportWarning {
	readonly code: CanvasPrintPreflightCode;
	readonly level: "warn";
	readonly measuredDpi?: number;
	readonly requiredDpi?: number;
}

export interface CanvasPrintPreflightOptions {
	/** The same metadata passed to `serializeDocumentToPdf`. */
	readonly print?: CanvasPrintPdfMetadata;
	/** Raster pixels per page unit, globally or by page id. Defaults to 1. */
	readonly rasterPixelRatio?: number | Readonly<Record<string, number>>;
	/** Families the renderer can load. Omit when availability is unknowable. */
	readonly availableFontFamilies?: readonly string[];
	/** Resolves brand-token font references to concrete family names. */
	readonly resolveFontFamily?: (
		fontFamily: CanvasFontFamily,
	) => string | undefined;
	/** Overrides the print contract's/default 150-DPI floor. */
	readonly minDpi?: number;
	/** Required bleed in inches. Ignored when `print.bleed` is specified. */
	readonly minBleedInches?: number;
	/** Required content margin in inches. Ignored when `print.margin` is specified. */
	readonly minMarginInches?: number;
}

export interface CanvasPrintPreflightResult {
	readonly issues: readonly CanvasPrintPreflightIssue[];
	readonly pageCount: number;
	readonly hasWarnings: boolean;
}

const IDENTITY: AffineMatrix = [1, 0, 0, 1, 0, 0];

function unitsPerInch(page: CanvasPage): number {
	switch (page.size.unit) {
		case "in":
			return 1;
		case "mm":
			return 25.4;
		default:
			return page.size.dpi ?? 96;
	}
}

function allEdgesAtLeast(
	insets: CanvasInsets | undefined,
	minimum: number,
): boolean {
	if (minimum <= 0) return true;
	if (!insets) return false;
	return (
		insets.top >= minimum &&
		insets.right >= minimum &&
		insets.bottom >= minimum &&
		insets.left >= minimum
	);
}

function uniformInsets(value: number): CanvasInsets {
	return { top: value, right: value, bottom: value, left: value };
}

function ratioForPage(
	value: CanvasPrintPreflightOptions["rasterPixelRatio"],
	pageId: string,
): number {
	const candidate = typeof value === "number" ? value : value?.[pageId];
	return Number.isFinite(candidate) && (candidate ?? 0) > 0
		? (candidate ?? 1)
		: 1;
}

function normalizedFamily(value: string): string {
	return value.trim().toLocaleLowerCase("en-US");
}

function resolveFamily(
	family: CanvasFontFamily,
	options: CanvasPrintPreflightOptions,
): string | undefined {
	if (typeof family === "string") return family;
	return options.resolveFontFamily?.(family);
}

function imageEffectiveDpi(
	node: CanvasImageNode,
	matrix: AffineMatrix,
	page: CanvasPage,
	assetWidth: number,
	assetHeight: number,
): number {
	const sourceWidth = node.crop?.width || assetWidth;
	const sourceHeight = node.crop?.height || assetHeight;
	if (sourceWidth <= 0 || sourceHeight <= 0) return 0;

	const widthUnits = Math.hypot(matrix[0], matrix[1]) * node.bounds.width;
	const heightUnits = Math.hypot(matrix[2], matrix[3]) * node.bounds.height;
	if (widthUnits <= 0 || heightUnits <= 0) return Number.POSITIVE_INFINITY;

	const unitScale = unitsPerInch(page);
	const fit = node.fitMode ?? "stretch";
	if (fit === "original" || fit === "center") return unitScale;
	if (fit === "fit" || fit === "fill") {
		const scale =
			fit === "fit"
				? Math.min(widthUnits / sourceWidth, heightUnits / sourceHeight)
				: Math.max(widthUnits / sourceWidth, heightUnits / sourceHeight);
		return scale > 0 ? unitScale / scale : Number.POSITIVE_INFINITY;
	}
	return Math.min(
		sourceWidth / (widthUnits / unitScale),
		sourceHeight / (heightUnits / unitScale),
	);
}

interface NodeEntry {
	readonly node: CanvasNode;
	readonly parentMatrix: AffineMatrix;
	readonly ancestorsVisible: boolean;
}

/**
 * Pure, deterministic print preflight. It performs no DOM/font/network access
 * and never mutates the IR, so callers can run it before allocating a canvas.
 */
export function preflightCanvasPrint(
	ir: CanvasIR,
	options: CanvasPrintPreflightOptions = {},
): CanvasPrintPreflightResult {
	const issues: CanvasPrintPreflightIssue[] = [];
	const minDpi = options.minDpi ?? options.print?.dpi ?? DEFAULT_PRINT_MIN_DPI;
	const availableFonts = options.availableFontFamilies
		? new Set(options.availableFontFamilies.map(normalizedFamily))
		: undefined;

	for (const page of ir.pages) {
		const unitScale = unitsPerInch(page);
		const requiredBleed =
			options.print?.bleed ??
			(options.minBleedInches ?? DEFAULT_PRINT_BLEED_INCHES) * unitScale;
		const requiredMargin =
			options.print?.margin ??
			(options.minMarginInches ?? DEFAULT_PRINT_MARGIN_INCHES) * unitScale;
		const ratio = ratioForPage(options.rasterPixelRatio, page.id);
		const pageDpi = Math.min(
			(page.size.width * ratio) / (page.size.width / unitScale),
			(page.size.height * ratio) / (page.size.height / unitScale),
		);
		if (Number.isFinite(pageDpi) && pageDpi < minDpi) {
			issues.push({
				level: "warn",
				code: "PRINT_PAGE_DPI_LOW",
				message: `Page "${page.id}" is estimated at ${Math.round(pageDpi)} DPI; print output requires at least ${minDpi} DPI.`,
				pageId: page.id,
				fallback: "Increase export scale or reduce the physical page size.",
				measuredDpi: pageDpi,
				requiredDpi: minDpi,
			});
		}

		if (!allEdgesAtLeast(page.layoutAids?.bleed, requiredBleed)) {
			issues.push({
				level: "warn",
				code: "PRINT_BLEED_INSUFFICIENT",
				message: `Page "${page.id}" does not provide the required ${requiredBleed.toFixed(2)} ${page.size.unit} bleed on every edge.`,
				pageId: page.id,
				fallback: "Set page bleed on all four edges before sending to print.",
			});
		}
		if (!allEdgesAtLeast(page.layoutAids?.margin, requiredMargin)) {
			issues.push({
				level: "warn",
				code: "PRINT_MARGIN_INSUFFICIENT",
				message: `Page "${page.id}" does not provide the required ${requiredMargin.toFixed(2)} ${page.size.unit} margin on every edge.`,
				pageId: page.id,
				fallback: "Increase page margins and move important content inward.",
			});
		}

		const safeArea =
			options.print?.safeArea ??
			page.layoutAids?.safeArea ??
			page.layoutAids?.margin ??
			uniformInsets(requiredMargin);
		const safeBounds = {
			minX: safeArea.left,
			minY: safeArea.top,
			maxX: page.size.width - safeArea.right,
			maxY: page.size.height - safeArea.bottom,
		};
		const rootMatrix = multiplyMatrix(
			IDENTITY,
			toAffineMatrix(page.root.transform),
		);
		const stack: NodeEntry[] = [...page.root.children]
			.reverse()
			.map((node) => ({
				node,
				parentMatrix: rootMatrix,
				ancestorsVisible: page.root.visible !== false,
			}));
		while (stack.length > 0) {
			const entry = stack.pop();
			if (!entry) break;
			const { node } = entry;
			const visible = entry.ancestorsVisible && node.visible !== false;
			const matrix = multiplyMatrix(
				entry.parentMatrix,
				toAffineMatrix(node.transform),
			);
			if (isContainerNode(node)) {
				for (let index = node.children.length - 1; index >= 0; index -= 1) {
					const child = node.children[index];
					if (child) {
						stack.push({
							node: child,
							parentMatrix: matrix,
							ancestorsVisible: visible,
						});
					}
				}
			}
			if (!visible || isContainerNode(node)) continue;

			const extent = matrixBoundsExtent(
				matrix,
				node.bounds.width,
				node.bounds.height,
			);
			if (
				extent.minX < safeBounds.minX ||
				extent.minY < safeBounds.minY ||
				extent.maxX > safeBounds.maxX ||
				extent.maxY > safeBounds.maxY
			) {
				issues.push({
					level: "warn",
					code: "PRINT_CONTENT_OUTSIDE_SAFE_AREA",
					message: `Node "${node.id}" extends outside page "${page.id}"'s safe area.`,
					pageId: page.id,
					nodeId: node.id,
					fallback: "Move important content inside the safe-area guides.",
				});
			}

			if (node.type === "image") {
				const asset = ir.assets[node.assetId];
				if (!asset?.width || !asset.height) {
					issues.push({
						level: "warn",
						code: "PRINT_IMAGE_DIMENSIONS_UNKNOWN",
						message: `Image "${node.id}" has no intrinsic pixel dimensions, so effective print resolution cannot be verified.`,
						pageId: page.id,
						nodeId: node.id,
						fallback:
							"Re-upload an image with intrinsic width and height metadata.",
					});
				} else {
					const effectiveDpi = imageEffectiveDpi(
						node,
						matrix,
						page,
						asset.width,
						asset.height,
					);
					if (Number.isFinite(effectiveDpi) && effectiveDpi < minDpi) {
						issues.push({
							level: "warn",
							code: "PRINT_IMAGE_RESOLUTION_LOW",
							message: `Image "${node.id}" is approximately ${Math.round(effectiveDpi)} DPI at its printed size; at least ${minDpi} DPI is required.`,
							pageId: page.id,
							nodeId: node.id,
							fallback:
								"Use a higher-resolution image or reduce its printed size.",
							measuredDpi: effectiveDpi,
							requiredDpi: minDpi,
						});
					}
				}
				if (node.filters && node.filters.length > 0) {
					issues.push({
						level: "warn",
						code: "PRINT_EFFECT_UNSUPPORTED",
						message: `Image "${node.id}" uses legacy filters that the print renderer cannot verify.`,
						pageId: page.id,
						nodeId: node.id,
						fallback:
							"Remove legacy filters or inspect a flattened proof before printing.",
					});
				}
			}

			const effectNode = node as CanvasNode & {
				effects?: Parameters<typeof resolveNodeEffects>[0]["effects"];
				shadow?: Parameters<typeof resolveNodeEffects>[0]["shadow"];
			};
			if (
				resolveNodeEffects(effectNode).some((effect) => effect.type === "blur")
			) {
				issues.push({
					level: "warn",
					code: "PRINT_EFFECT_UNSUPPORTED",
					message: `Node "${node.id}" uses a blur effect that is not rendered by the raster print path.`,
					pageId: page.id,
					nodeId: node.id,
					fallback:
						"Remove the blur or flatten and inspect the artwork before printing.",
				});
			}

			const families: CanvasFontFamily[] = [];
			if (node.type === "text") families.push(node.fontFamily);
			if (node.type === "rich-text") {
				for (const paragraph of node.paragraphs) {
					for (const span of paragraph.spans) {
						families.push(
							span.fontFamily ?? DEFAULT_RICH_TEXT_STYLE.fontFamily,
						);
					}
				}
			}
			const seenFamilies = new Set<string>();
			for (const family of families) {
				const resolved = resolveFamily(family, options);
				if (!resolved) {
					const tokenId = typeof family === "string" ? family : family.id;
					if (seenFamilies.has(`unresolved:${tokenId}`)) continue;
					seenFamilies.add(`unresolved:${tokenId}`);
					issues.push({
						level: "warn",
						code: "PRINT_FONT_UNRESOLVED",
						message: `Node "${node.id}" uses unresolved font token "${tokenId}".`,
						pageId: page.id,
						nodeId: node.id,
						fallback:
							"Resolve the brand font token or choose an available font.",
					});
					continue;
				}
				const key = normalizedFamily(resolved);
				if (seenFamilies.has(key)) continue;
				seenFamilies.add(key);
				if (availableFonts && !availableFonts.has(key)) {
					issues.push({
						level: "warn",
						code: "PRINT_FONT_MISSING",
						message: `Font "${resolved}" used by node "${node.id}" is not available to the print renderer.`,
						pageId: page.id,
						nodeId: node.id,
						fallback:
							"Install or provide the font, or replace it with an available family.",
					});
				}
			}
		}
	}

	return {
		issues,
		pageCount: ir.pages.length,
		hasWarnings: issues.length > 0,
	};
}
