import { describe, expect, it } from "vitest";
import type { CanvasExportWarning } from "../../export/types.js";
import type { PdfSerializeWarning } from "../pdf.js";
import type { SvgSerializeWarning } from "../svg.js";

/**
 * FR-041 (canvas-m3-002) additive coverage: existing warning shapes gained an
 * optional `fallback` field, and two new grow-only codes were added
 * (`SVG_INLINE_UNSUPPORTED` for FR-016/canvas-m3-005, `PRINT_UNSAFE` for
 * FR-043/canvas-m3-004). Neither code has an emit site yet — this only
 * proves the shapes accept them, which is what those later tasks build on.
 */
describe("SvgSerializeWarning (FR-041 extension)", () => {
	it("accepts an optional fallback field", () => {
		const warning: SvgSerializeWarning = {
			code: "MISSING_ASSET",
			message: "asset not found",
			fallback: "falls back to a neutral gray fill",
		};
		expect(warning.fallback).toBe("falls back to a neutral gray fill");
	});

	it("omits fallback without error (backward compatible)", () => {
		const warning: SvgSerializeWarning = {
			code: "MISSING_ASSET",
			message: "asset not found",
		};
		expect(warning.fallback).toBeUndefined();
	});

	it("accepts the new SVG_INLINE_UNSUPPORTED code (FR-016 wiring point)", () => {
		const warning: SvgSerializeWarning = {
			code: "SVG_INLINE_UNSUPPORTED",
			message: "svg node rendered as an image asset reference",
		};
		expect(warning.code).toBe("SVG_INLINE_UNSUPPORTED");
	});
});

describe("PdfSerializeWarning (FR-041 extension)", () => {
	it("accepts an optional fallback field", () => {
		const warning: PdfSerializeWarning = {
			code: "RASTER_MISSING",
			message: "no raster supplied for page",
			fallback: "page rendered blank",
		};
		expect(warning.fallback).toBe("page rendered blank");
	});

	it("accepts the new PRINT_UNSAFE code (FR-043 wiring point)", () => {
		const warning: PdfSerializeWarning = {
			code: "PRINT_UNSAFE",
			message: "raster below print-safe resolution",
		};
		expect(warning.code).toBe("PRINT_UNSAFE");
	});
});

describe("CanvasExportWarning (FR-041, FR-040 job contract)", () => {
	it("accepts an optional fallback field alongside the format-agnostic string code", () => {
		const warning: CanvasExportWarning = {
			level: "warn",
			code: "SVG_INLINE_UNSUPPORTED",
			message: "svg node rendered as an image asset reference",
			fallback: "sanitize and re-upload as a raster to embed inline",
		};
		expect(warning.fallback).toBeDefined();
	});
});
