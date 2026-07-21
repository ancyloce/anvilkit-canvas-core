import { describe, expect, it } from "vitest";
import type {
	CanvasIR,
	CanvasPage,
	CanvasPageSize,
	CanvasTransform,
} from "../../ir/types.js";
import { serializeDocumentToPdf } from "../pdf.js";

/** A valid 1×1 transparent PNG — deliberately far below any print-safe DPI once embedded onto a full page. */
const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_1X1_DATA_URL = `data:image/png;base64,${PNG_1X1}`;

function transform(): CanvasTransform {
	return { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
}

function makePage(id: string, size: CanvasPageSize): CanvasPage {
	return {
		id,
		size,
		background: { kind: "solid", value: "#ffffff" },
		root: {
			id: `${id}-root`,
			type: "group",
			transform: transform(),
			bounds: { width: size.width, height: size.height },
			zIndex: 0,
			children: [],
		},
	};
}

function makeIr(pages: CanvasPage[]): CanvasIR {
	return {
		version: "2",
		id: "doc-print",
		title: "Print Doc",
		pages,
		assets: {},
		metadata: {
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

describe("serializeDocumentToPdf — print safety (FR-043, canvas-m3-004)", () => {
	it("does not check print safety when `print` is omitted", async () => {
		const ir = makeIr([makePage("p1", { width: 8.5, height: 11, unit: "in" })]);
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [{ pageId: "p1", image: PNG_1X1_DATA_URL }],
		});
		expect(warnings.filter((w) => w.code === "PRINT_UNSAFE")).toHaveLength(0);
	});

	it("warns PRINT_UNSAFE for a raster far below the default 150 DPI floor", async () => {
		const ir = makeIr([makePage("p1", { width: 8.5, height: 11, unit: "in" })]);
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [{ pageId: "p1", image: PNG_1X1_DATA_URL }],
			print: { capabilities: { raster: true, vector: false } },
		});
		const unsafe = warnings.filter((w) => w.code === "PRINT_UNSAFE");
		expect(unsafe).toHaveLength(1);
		expect(unsafe[0]?.pageId).toBe("p1");
		expect(unsafe[0]?.fallback).toBeDefined();
	});

	it("respects a custom print.dpi threshold", async () => {
		const ir = makeIr([makePage("p1", { width: 8.5, height: 11, unit: "in" })]);
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [{ pageId: "p1", image: PNG_1X1_DATA_URL }],
			// A 1px raster is unsafe even at a DPI floor of 1 only if the page
			// is smaller than 1 inch wide — this page is 8.5in, so even dpi: 1
			// still fails (1px / 8.5in ≈ 0.12 dpi), proving the threshold is honored.
			print: { dpi: 1, capabilities: { raster: true, vector: false } },
		});
		expect(warnings.filter((w) => w.code === "PRINT_UNSAFE")).toHaveLength(1);
	});

	it("does not warn when the effective DPI meets the floor (small page, same raster)", async () => {
		// A 1px raster on a page just under 1/150 inch wide clears a 150 DPI floor.
		const ir = makeIr([
			makePage("p1", { width: 1 / 200, height: 1 / 200, unit: "in" }),
		]);
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [{ pageId: "p1", image: PNG_1X1_DATA_URL }],
			print: { capabilities: { raster: true, vector: false } },
		});
		expect(warnings.filter((w) => w.code === "PRINT_UNSAFE")).toHaveLength(0);
	});

	it("checks height DPI too, not just width — safe width but unsafe height still warns (C-18)", async () => {
		// A 1x1 raster: width DPI = 1px / (1/200in) = 200 (safe, clears 150).
		// Height DPI = 1px / 11in ≈ 0.09 (drastically unsafe). Checking width
		// alone would miss this.
		const ir = makeIr([
			makePage("p1", { width: 1 / 200, height: 11, unit: "in" }),
		]);
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [{ pageId: "p1", image: PNG_1X1_DATA_URL }],
			print: { capabilities: { raster: true, vector: false } },
		});
		expect(warnings.filter((w) => w.code === "PRINT_UNSAFE")).toHaveLength(1);
	});

	it("does not check pages whose raster is missing (RASTER_MISSING wins, no double-warning)", async () => {
		const ir = makeIr([makePage("p1", { width: 8.5, height: 11, unit: "in" })]);
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [],
			print: { capabilities: { raster: true, vector: false } },
		});
		expect(warnings).toEqual([
			{
				code: "RASTER_MISSING",
				message: expect.stringContaining("p1"),
				pageId: "p1",
			},
		]);
	});
});
