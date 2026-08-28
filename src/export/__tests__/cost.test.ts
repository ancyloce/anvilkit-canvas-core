import { describe, expect, it } from "vitest";
import { createPage } from "../../ir/builders.js";
import {
	assertCanvasExportWithinLimits,
	checkCanvasExportLimits,
	DEFAULT_CANVAS_EXPORT_LIMITS,
	DEFAULT_EXPORT_BYTES_PER_PIXEL,
	estimateCanvasExportCost,
	resolveCanvasExportLimits,
} from "../cost.js";

describe("estimateCanvasExportCost", () => {
	it("calculates exact raster edges, per-page pixels, totals, and memory", () => {
		const estimate = estimateCanvasExportCost({
			format: "png",
			pages: [
				createPage({
					id: "square",
					size: { width: 1_080, height: 1_080, unit: "px" },
				}),
				createPage({
					id: "wide",
					size: { width: 1_920, height: 1_080, unit: "px" },
				}),
			],
			pixelRatio: 2,
		});

		expect(estimate.pages).toEqual([
			{
				pageId: "square",
				outputWidth: 2_160,
				outputHeight: 2_160,
				outputEdge: 2_160,
				pixels: 4_665_600,
				estimatedMemoryBytes: 4_665_600 * DEFAULT_EXPORT_BYTES_PER_PIXEL,
			},
			{
				pageId: "wide",
				outputWidth: 3_840,
				outputHeight: 2_160,
				outputEdge: 3_840,
				pixels: 8_294_400,
				estimatedMemoryBytes: 8_294_400 * DEFAULT_EXPORT_BYTES_PER_PIXEL,
			},
		]);
		expect(estimate).toMatchObject({
			pageCount: 2,
			maxOutputEdge: 3_840,
			maxPixelsPerPage: 8_294_400,
			totalPixels: 12_960_000,
			estimatedMemoryBytes: 51_840_000,
			estimatedPeakPageMemoryBytes: 33_177_600,
			likelyExecutionTier: "main-thread",
		});
	});

	it("honors per-page non-proportional output ratios", () => {
		const estimate = estimateCanvasExportCost({
			format: "pdf-print",
			pages: [
				createPage({
					id: "print",
					size: { width: 100, height: 200, unit: "px" },
				}),
			],
			pixelRatio: 2,
			pixelRatios: { print: { x: 3, y: 4 } },
		});

		expect(estimate.pages[0]).toMatchObject({
			outputWidth: 300,
			outputHeight: 800,
			outputEdge: 800,
			pixels: 240_000,
		});
	});

	it.each(["svg", "json"] as const)(
		"costs %s without inventing a raster allocation",
		(format) => {
			const estimate = estimateCanvasExportCost({
				format,
				pages: [
					createPage({
						id: "page",
						size: { width: 640, height: 480, unit: "px" },
					}),
				],
			});

			expect(estimate.pages[0]).toMatchObject({
				outputWidth: 640,
				outputHeight: 480,
				pixels: 0,
			});
			expect(estimate).toMatchObject({
				totalPixels: 0,
				estimatedMemoryBytes: 0,
				likelyExecutionTier: "main-thread",
			});
		},
	);

	it("classifies configurable background and server tiers", () => {
		const page = createPage({
			id: "page",
			size: { width: 100, height: 100, unit: "px" },
		});
		expect(
			estimateCanvasExportCost({
				format: "jpeg",
				pages: [page],
				mainThreadPixelBudget: 9_999,
				backgroundPixelBudget: 10_000,
			}).likelyExecutionTier,
		).toBe("background");
		expect(
			estimateCanvasExportCost({
				format: "jpeg",
				pages: [page],
				mainThreadPixelBudget: 9_998,
				backgroundPixelBudget: 9_999,
			}).likelyExecutionTier,
		).toBe("server");
	});

	it("rejects invalid ratios before any output cost is trusted", () => {
		expect(() =>
			estimateCanvasExportCost({
				format: "webp",
				pages: [createPage({ id: "page" })],
				pixelRatio: 0,
			}),
		).toThrow("Export pixel ratios must be finite and greater than zero.");
	});
});

describe("canvas export hard limits", () => {
	const page = createPage({
		id: "page",
		size: { width: 100, height: 100, unit: "px" },
	});

	it("publishes the PLAN-0039 E2-T2 defaults", () => {
		expect(DEFAULT_CANVAS_EXPORT_LIMITS).toEqual({
			maxOutputEdge: 8_192,
			maxPixelsPerPage: 64_000_000,
			maxTotalPixels: 256_000_000,
			maxPages: 100,
			maxScale: 4,
		});
	});

	it.each([
		["maxOutputEdge", 8_192],
		["maxPixelsPerPage", 64_000_000],
		["maxTotalPixels", 256_000_000],
		["maxPages", 100],
		["maxScale", 4],
	] as const)(
		"accepts the %s boundary and rejects boundary plus one",
		(key, limit) => {
			const baseEstimate = estimateCanvasExportCost({
				format: "png",
				pages: [page],
			});
			const estimate = {
				...baseEstimate,
				...(key === "maxOutputEdge"
					? {
							maxOutputEdge: limit + 1,
							pages: [{ ...baseEstimate.pages[0]!, outputEdge: limit + 1 }],
						}
					: {}),
				...(key === "maxPixelsPerPage"
					? {
							maxPixelsPerPage: limit + 1,
							pages: [{ ...baseEstimate.pages[0]!, pixels: limit + 1 }],
						}
					: {}),
				...(key === "maxTotalPixels" ? { totalPixels: limit + 1 } : {}),
				...(key === "maxPages" ? { pageCount: limit + 1 } : {}),
			};
			const overrides = { [key]: limit };
			const rejected = checkCanvasExportLimits({
				estimate,
				requestedScale: key === "maxScale" ? limit + 1 : 1,
				limits: overrides,
			});
			expect(rejected.ok).toBe(false);

			const accepted = checkCanvasExportLimits({
				estimate: baseEstimate,
				requestedScale: key === "maxScale" ? limit : 1,
				limits: overrides,
			});
			expect(accepted.ok).toBe(true);
		},
	);

	it("returns limiting factor, cost, and a safe corrective action", () => {
		const estimate = estimateCanvasExportCost({
			format: "png",
			pages: [page],
			pixelRatio: 2,
		});
		expect(() =>
			assertCanvasExportWithinLimits({
				estimate,
				limits: { maxPixelsPerPage: 10_000 },
			}),
		).toThrow(/40,000 pixels|0\.04 MP|Reduce the export scale/i);
		const result = checkCanvasExportLimits({
			estimate,
			limits: { maxPixelsPerPage: 10_000 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.violations[0]).toMatchObject({
				code: "EXPORT_PAGE_PIXELS_LIMIT",
				observed: 40_000,
				limit: 10_000,
				pageId: "page",
			});
			expect(result.violations[0]?.safeAction).toMatch(/Reduce/);
		}
	});

	it("validates host overrides instead of accepting unusable policies", () => {
		expect(() => resolveCanvasExportLimits({ maxPages: 1.5 })).toThrow(
			"maxPages must be an integer",
		);
		expect(() => resolveCanvasExportLimits({ maxScale: 0 })).toThrow(
			"maxScale must be finite and greater than zero",
		);
	});
});
