import { describe, expect, it } from "vitest";
import {
	CanvasExportDiagnosticError,
	canvasExportDiagnosticForWarning,
	canvasExportDiagnosticsForWarnings,
	createCanvasExportDiagnostic,
	normalizeCanvasExportError,
} from "../diagnostics.js";

describe("export diagnostic taxonomy", () => {
	it("assigns a distinct stable code to every required failure class", () => {
		expect(
			normalizeCanvasExportError(new Error("bad format"), {
				unsupportedFormat: "tiff",
			}),
		).toMatchObject({
			category: "unsupported-format",
			code: "CANVAS_EXPORT_UNSUPPORTED_FORMAT",
		});
		expect(
			normalizeCanvasExportError({
				code: "CANVAS_EXPORT_BUDGET_EXCEEDED",
			}),
		).toMatchObject({
			category: "budget-rejection",
			code: "CANVAS_EXPORT_BUDGET_EXCEEDED",
		});
		expect(
			normalizeCanvasExportError(new Error("adapter offline"), {
				source: "provider",
			}),
		).toMatchObject({
			category: "provider-failure",
			code: "CANVAS_EXPORT_PROVIDER_FAILED",
		});
		expect(
			normalizeCanvasExportError(new Error("stopped"), { cancelled: true }),
		).toMatchObject({
			category: "cancellation",
			code: "CANVAS_EXPORT_CANCELLED",
		});
		expect(
			normalizeCanvasExportError(new Error("canvas failed")),
		).toMatchObject({
			category: "rendering-failure",
			code: "CANVAS_EXPORT_RENDER_FAILED",
		});
	});

	it("normalizes missing assets and fonts while retaining source codes and locations", () => {
		const diagnostics = canvasExportDiagnosticsForWarnings([
			{
				level: "warn",
				code: "MISSING_ASSET",
				message: "asset gone",
				nodeId: "image-1",
				fallback: "replace it",
			},
			{
				level: "warn",
				code: "FONT_NOT_IN_MANIFEST",
				message: "font gone",
				pageId: "p1",
			},
		]);
		expect(diagnostics).toEqual([
			expect.objectContaining({
				category: "missing-asset",
				code: "CANVAS_EXPORT_MISSING_ASSET",
				sourceCode: "MISSING_ASSET",
				nodeId: "image-1",
				correctiveAction: "replace it",
			}),
			expect.objectContaining({
				category: "missing-font",
				code: "CANVAS_EXPORT_MISSING_FONT",
				sourceCode: "FONT_NOT_IN_MANIFEST",
				pageId: "p1",
			}),
		]);
	});

	it("classifies other serializer warnings as rendering diagnostics without losing fidelity detail", () => {
		const diagnostic = canvasExportDiagnosticForWarning({
			level: "warn",
			code: "BLENDMODE_UNSUPPORTED",
			message: "blend mode flattened",
			fallback: "inspect the proof",
		});
		expect(diagnostic).toMatchObject({
			category: "rendering-failure",
			code: "CANVAS_EXPORT_RENDER_FAILED",
			level: "warn",
			sourceCode: "BLENDMODE_UNSUPPORTED",
			message: "blend mode flattened",
			correctiveAction: "inspect the proof",
		});
	});

	it("wraps formerly untyped errors without discarding their cause", () => {
		const cause = new Error("renderer exploded");
		const diagnostic = createCanvasExportDiagnostic("rendering-failure");
		const error = new CanvasExportDiagnosticError(diagnostic, cause);
		expect(error.code).toBe("CANVAS_EXPORT_RENDER_FAILED");
		expect(error.diagnostic).toBe(diagnostic);
		expect(error.cause).toBe(cause);
	});
});
