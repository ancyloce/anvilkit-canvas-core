import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import type {
	CanvasIR,
	CanvasPage,
	CanvasPageSize,
	CanvasTransform,
} from "../ir/types.js";
import { serializeDocumentToPdf, unitToPt } from "../serialize/pdf.js";

/** A valid 1×1 transparent PNG (verified to embed via pdf-lib's decoder). */
const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG_1X1_DATA_URL = `data:image/png;base64,${PNG_1X1}`;
const PNG_1X1_BYTES = new Uint8Array(Buffer.from(PNG_1X1, "base64"));

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
		id: "doc-pdf",
		title: "PDF Doc",
		pages,
		assets: {},
		metadata: {
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

function hasPdfHeader(bytes: Uint8Array): boolean {
	return Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-";
}

describe("unitToPt", () => {
	it("converts inches at 72 points per inch", () => {
		expect(unitToPt(1, "in", 96)).toBeCloseTo(72, 6);
		expect(unitToPt(2, "in", 96)).toBeCloseTo(144, 6);
	});

	it("converts millimetres through 25.4 mm per inch", () => {
		expect(unitToPt(25.4, "mm", 96)).toBeCloseTo(72, 6);
		expect(unitToPt(50.8, "mm", 96)).toBeCloseTo(144, 6);
	});

	it("scales pixels through the supplied dpi", () => {
		expect(unitToPt(96, "px", 96)).toBeCloseTo(72, 6);
		expect(unitToPt(72, "px", 72)).toBeCloseTo(72, 6);
		expect(unitToPt(150, "px", 300)).toBeCloseTo(36, 6);
	});
});

describe("serializeDocumentToPdf", () => {
	it("renders one PDF page per CanvasPage with no warnings on the happy path", async () => {
		const ir = makeIr([
			makePage("p1", { width: 96, height: 48, unit: "px" }), // → 72×36 pt @ 96dpi
			makePage("p2", { width: 2, height: 1, unit: "in" }), // → 144×72 pt
		]);

		const { pdf, warnings } = await serializeDocumentToPdf(ir, {
			rasters: [
				{ pageId: "p1", image: PNG_1X1_DATA_URL },
				{ pageId: "p2", image: PNG_1X1_DATA_URL },
			],
		});

		expect(warnings).toEqual([]);
		expect(hasPdfHeader(pdf)).toBe(true);

		const loaded = await PDFDocument.load(pdf);
		expect(loaded.getPageCount()).toBe(2);

		const [first, second] = loaded.getPages();
		expect(first.getWidth()).toBeCloseTo(72, 2);
		expect(first.getHeight()).toBeCloseTo(36, 2);
		expect(second.getWidth()).toBeCloseTo(144, 2);
		expect(second.getHeight()).toBeCloseTo(72, 2);
	});

	it("converts mm/px/in page sizes to physical points", async () => {
		const ir = makeIr([
			makePage("mm", { width: 25.4, height: 50.8, unit: "mm" }), // 72×144 pt
			makePage("px", { width: 96, height: 96, unit: "px", dpi: 96 }), // 72×72 pt
			makePage("in", { width: 1, height: 3, unit: "in" }), // 72×216 pt
		]);

		const { pdf, warnings } = await serializeDocumentToPdf(ir, {
			rasters: ir.pages.map((p) => ({ pageId: p.id, image: PNG_1X1_DATA_URL })),
		});

		expect(warnings).toEqual([]);
		const pages = (await PDFDocument.load(pdf)).getPages();
		expect(
			pages.map((p) => [round(p.getWidth()), round(p.getHeight())]),
		).toEqual([
			[72, 144],
			[72, 72],
			[72, 216],
		]);
	});

	it("accepts raw Uint8Array rasters", async () => {
		const ir = makeIr([
			makePage("p1", { width: 72, height: 72, unit: "px", dpi: 72 }),
		]);
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [{ pageId: "p1", image: PNG_1X1_BYTES, mimeType: "image/png" }],
		});
		expect(warnings).toEqual([]);
	});

	it("emits a blank page with a RASTER_MISSING warning when a raster is absent", async () => {
		const ir = makeIr([
			makePage("p1", { width: 72, height: 72, unit: "px", dpi: 72 }),
			makePage("p2", { width: 72, height: 72, unit: "px", dpi: 72 }),
		]);

		const { pdf, warnings } = await serializeDocumentToPdf(ir, {
			rasters: [{ pageId: "p1", image: PNG_1X1_DATA_URL }],
		});

		// Page count is unchanged — the missing page is blank, not dropped.
		expect((await PDFDocument.load(pdf)).getPageCount()).toBe(2);
		expect(warnings).toEqual([
			{
				code: "RASTER_MISSING",
				message: expect.stringContaining("p2"),
				pageId: "p2",
			},
		]);
	});

	it("warns RASTER_UNSUPPORTED_MIME for a non-png/jpeg data URL or mime", async () => {
		const ir = makeIr([
			makePage("a", { width: 72, height: 72, unit: "px", dpi: 72 }),
			makePage("b", { width: 72, height: 72, unit: "px", dpi: 72 }),
		]);

		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [
				{ pageId: "a", image: "data:image/gif;base64,R0lGODdh" },
				{ pageId: "b", image: PNG_1X1_BYTES, mimeType: "image/webp" as never },
			],
		});

		expect(warnings.map((w) => w.code)).toEqual([
			"RASTER_UNSUPPORTED_MIME",
			"RASTER_UNSUPPORTED_MIME",
		]);
	});

	it("warns RASTER_DECODE_FAILED when bytes do not match the declared format", async () => {
		const ir = makeIr([
			makePage("p1", { width: 72, height: 72, unit: "px", dpi: 72 }),
		]);
		// PNG bytes declared as JPEG → pdf-lib's embedJpg rejects them.
		const { pdf, warnings } = await serializeDocumentToPdf(ir, {
			rasters: [{ pageId: "p1", image: PNG_1X1_BYTES, mimeType: "image/jpeg" }],
		});

		expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.code).toBe("RASTER_DECODE_FAILED");
		expect(warnings[0]?.pageId).toBe("p1");
	});

	it("honours the `pages` selector for subsetting and reordering", async () => {
		const ir = makeIr([
			makePage("a", { width: 100, height: 10, unit: "px", dpi: 72 }),
			makePage("b", { width: 100, height: 20, unit: "px", dpi: 72 }),
			makePage("c", { width: 100, height: 30, unit: "px", dpi: 72 }),
		]);

		const { pdf } = await serializeDocumentToPdf(ir, {
			pages: ["c", "a"],
			rasters: ir.pages.map((p) => ({ pageId: p.id, image: PNG_1X1_DATA_URL })),
		});

		const pages = (await PDFDocument.load(pdf)).getPages();
		expect(pages).toHaveLength(2);
		expect(round(pages[0]?.getHeight() ?? 0)).toBe(30); // "c" first
		expect(round(pages[1]?.getHeight() ?? 0)).toBe(10); // "a" second
	});

	it("writes title/author metadata when supplied", async () => {
		const ir = makeIr([
			makePage("p1", { width: 72, height: 72, unit: "px", dpi: 72 }),
		]);
		const { pdf } = await serializeDocumentToPdf(ir, {
			title: "My Design",
			author: "AnvilKit",
			rasters: [{ pageId: "p1", image: PNG_1X1_DATA_URL }],
		});

		const loaded = await PDFDocument.load(pdf);
		expect(loaded.getTitle()).toBe("My Design");
		expect(loaded.getAuthor()).toBe("AnvilKit");
	});

	it("throws when there are no pages to render", async () => {
		await expect(
			serializeDocumentToPdf(makeIr([]), { rasters: [] }),
		).rejects.toThrow(RangeError);

		const ir = makeIr([makePage("p1", { width: 72, height: 72, unit: "px" })]);
		await expect(
			serializeDocumentToPdf(ir, { pages: [], rasters: [] }),
		).rejects.toThrow(RangeError);
	});

	it("throws on an unknown page selector", async () => {
		const ir = makeIr([makePage("p1", { width: 72, height: 72, unit: "px" })]);
		await expect(
			serializeDocumentToPdf(ir, { pages: ["nope"], rasters: [] }),
		).rejects.toThrow(/not be? found|not found/i);
		await expect(
			serializeDocumentToPdf(ir, { pages: [99], rasters: [] }),
		).rejects.toThrow(RangeError);
	});

	it("throws a RangeError on a page with non-finite dimensions (no NaN PDF)", async () => {
		const ir = makeIr([
			makePage("p1", { width: Number.NaN, height: 72, unit: "px" }),
		]);
		await expect(serializeDocumentToPdf(ir, { rasters: [] })).rejects.toThrow(
			/non-finite dimensions/i,
		);
	});

	it("validate:true rejects an IR with a non-finite page size", async () => {
		const ir = makeIr([
			makePage("p1", {
				width: Number.POSITIVE_INFINITY,
				height: 72,
				unit: "px",
			}),
		]);
		await expect(
			serializeDocumentToPdf(ir, { rasters: [], validate: true }),
		).rejects.toThrow();
	});
});

/** Round a point dimension to the nearest integer for stable comparison. */
function round(n: number): number {
	return Math.round(n);
}
