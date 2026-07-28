import { describe, expect, it } from "vitest";
import { layoutIssuesToExportWarnings } from "../export-warnings.js";
import type { CanvasLayoutIssue } from "../validate.js";

/**
 * @file T-M3-03 (TS-45, unit half) — layout diagnostics map into the unified
 * `CanvasExportWarning` shape without `export/` ever importing layout types.
 * The integration half (diagnostics visible in a real export result) lands
 * with the export-path migration (T-M3-10).
 */

const issues: CanvasLayoutIssue[] = [
	{
		code: "layout-insufficient-space",
		severity: "warning",
		nodeId: "f1",
		axis: "horizontal",
		message: "Children overflow the container.",
		fallback: "zero-fill",
	},
	{
		code: "layout-circular-sizing",
		severity: "error",
		nodeId: "f2",
		message: "Hug/Fill cycle detected.",
		fallback: "cached-geometry",
	},
	{
		code: "layout-materialization-stale",
		severity: "warning",
		message: "The materialized cache does not match the document.",
	},
];

describe("layoutIssuesToExportWarnings", () => {
	it("maps 1:1, severity→level, carrying code/nodeId/fallback", () => {
		const warnings = layoutIssuesToExportWarnings(issues);
		expect(warnings).toEqual([
			{
				level: "warn",
				code: "layout-insufficient-space",
				message: "Children overflow the container.",
				nodeId: "f1",
				fallback: "zero-fill",
			},
			{
				level: "error",
				code: "layout-circular-sizing",
				message: "Hug/Fill cycle detected.",
				nodeId: "f2",
				fallback: "cached-geometry",
			},
			{
				level: "warn",
				code: "layout-materialization-stale",
				message: "The materialized cache does not match the document.",
			},
		]);
	});

	it("omits absent optional fields instead of writing undefined", () => {
		const [warning] = layoutIssuesToExportWarnings([
			{
				code: "layout-negative-gap",
				severity: "error",
				message: "Gap must be non-negative.",
			},
		]);
		expect(warning).toBeDefined();
		expect(Object.keys(warning ?? {})).toEqual(["level", "code", "message"]);
	});

	it("stamps pageId onto every warning for per-page batches", () => {
		const warnings = layoutIssuesToExportWarnings(issues, { pageId: "p1" });
		expect(warnings.every((w) => w.pageId === "p1")).toBe(true);
	});

	it("returns an empty array for no issues", () => {
		expect(layoutIssuesToExportWarnings([])).toEqual([]);
	});
});
