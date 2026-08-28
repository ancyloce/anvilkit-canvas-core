import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createImage,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import type { CanvasNode } from "../../ir/types.js";
import {
	DEFAULT_PRINT_BLEED_INCHES,
	DEFAULT_PRINT_MARGIN_INCHES,
	preflightCanvasPrint,
} from "../../print-preflight.js";

const NOW = "2026-08-28T00:00:00.000Z";

function documentWith(nodes: CanvasNode[]) {
	const page = createPage({
		id: "p1",
		size: { width: 1200, height: 1200, unit: "px", dpi: 96 },
		root: createGroup({
			id: "root",
			bounds: { width: 1200, height: 1200 },
			children: nodes,
		}),
	});
	return createCanvasIR({ pages: [page], now: () => NOW });
}

describe("preflightCanvasPrint", () => {
	it("returns no findings for a print-safe page", () => {
		const image = createImage({
			id: "photo",
			assetId: "asset-photo",
			bounds: { width: 300, height: 300 },
			transform: { x: 100, y: 100 },
		});
		const text = createText({
			id: "title",
			text: "Print",
			fontFamily: "Inter",
			bounds: { width: 300, height: 50 },
			transform: { x: 100, y: 500 },
		});
		const ir = documentWith([image, text]);
		ir.assets["asset-photo"] = {
			id: "asset-photo",
			uri: "https://example.invalid/photo.png",
			width: 1200,
			height: 1200,
		};
		ir.pages[0]!.layoutAids = {
			bleed: { top: 12, right: 12, bottom: 12, left: 12 },
			margin: { top: 24, right: 24, bottom: 24, left: 24 },
			safeArea: { top: 24, right: 24, bottom: 24, left: 24 },
		};

		const result = preflightCanvasPrint(ir, {
			rasterPixelRatio: 2,
			availableFontFamilies: ["inter"],
		});
		expect(result).toEqual({ issues: [], pageCount: 1, hasWarnings: false });
	});

	it("identifies low page/image DPI, bleed, margins, safe-area, fonts, and unsupported effects", () => {
		const unsafeRect = {
			...createRect({
				id: "blurred",
				bounds: { width: 100, height: 100 },
				transform: { x: 0, y: 0 },
			}),
			effects: [{ type: "blur" as const, radius: 8 }],
		};
		const image = createImage({
			id: "low-res",
			assetId: "asset-low",
			bounds: { width: 600, height: 600 },
			transform: { x: 300, y: 300 },
			filters: [{ kind: "legacy-filter" }],
		});
		const text = createText({
			id: "missing-font",
			text: "Missing",
			fontFamily: "Unavailable Sans",
			bounds: { width: 200, height: 50 },
			transform: { x: 400, y: 400 },
		});
		const ir = documentWith([unsafeRect, image, text]);
		ir.assets["asset-low"] = {
			id: "asset-low",
			uri: "https://example.invalid/low.png",
			width: 100,
			height: 100,
		};

		const result = preflightCanvasPrint(ir, {
			rasterPixelRatio: 1,
			availableFontFamilies: ["Inter"],
		});
		const codes = new Set(result.issues.map((issue) => issue.code));
		expect(codes).toEqual(
			new Set([
				"PRINT_PAGE_DPI_LOW",
				"PRINT_BLEED_INSUFFICIENT",
				"PRINT_MARGIN_INSUFFICIENT",
				"PRINT_CONTENT_OUTSIDE_SAFE_AREA",
				"PRINT_IMAGE_RESOLUTION_LOW",
				"PRINT_FONT_MISSING",
				"PRINT_EFFECT_UNSUPPORTED",
			]),
		);
		expect(
			result.issues.find((issue) => issue.code === "PRINT_IMAGE_RESOLUTION_LOW")
				?.fallback,
		).toMatch(/higher-resolution/i);
	});

	it("reports unknown image dimensions and unresolved brand font tokens", () => {
		const ir = documentWith([
			createImage({
				id: "unknown-image",
				assetId: "unknown",
				bounds: { width: 100, height: 100 },
				transform: { x: 100, y: 100 },
			}),
			createText({
				id: "token-font",
				text: "Token",
				fontFamily: {
					type: "brand-token",
					tokenType: "font",
					id: "brand.heading",
				},
				bounds: { width: 100, height: 30 },
				transform: { x: 100, y: 300 },
			}),
		]);
		ir.assets.unknown = { id: "unknown", uri: "blob:unknown" };
		const codes = preflightCanvasPrint(ir, {
			rasterPixelRatio: 2,
			availableFontFamilies: ["Inter"],
			resolveFontFamily: () => undefined,
		}).issues.map((issue) => issue.code);
		expect(codes).toContain("PRINT_IMAGE_DIMENSIONS_UNKNOWN");
		expect(codes).toContain("PRINT_FONT_UNRESOLVED");
	});

	it("honors custom print thresholds and never mutates the document", () => {
		const ir = documentWith([]);
		const before = JSON.stringify(ir);
		const result = preflightCanvasPrint(ir, {
			minDpi: 96,
			rasterPixelRatio: 1,
			minBleedInches: 0,
			minMarginInches: 0,
		});
		expect(result.issues).toHaveLength(0);
		expect(JSON.stringify(ir)).toBe(before);
	});

	it("publishes explicit physical default thresholds", () => {
		expect(DEFAULT_PRINT_BLEED_INCHES).toBe(0.125);
		expect(DEFAULT_PRINT_MARGIN_INCHES).toBe(0.25);
	});
});
