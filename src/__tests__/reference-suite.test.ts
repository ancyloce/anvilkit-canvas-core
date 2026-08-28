import { describe, expect, it } from "vitest";
import { buildReferenceDocument } from "../../bench/fixtures/reference-documents.js";
import {
	CANVAS_REFERENCE_DOCUMENT_FIXTURES,
	CANVAS_REFERENCE_ENVIRONMENTS,
	CANVAS_REFERENCE_SUITE_VERSION,
	canvasReferenceFixtureLabel,
} from "../../bench/reference-suite.js";
import { CanvasIRSchema } from "../ir/validators.js";

describe("Canvas reference suite (E0-T2)", () => {
	it("versions unique desktop, low-tier, touch, and headless environments", () => {
		expect(CANVAS_REFERENCE_SUITE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		expect(
			new Set(CANVAS_REFERENCE_ENVIRONMENTS.map(({ id }) => id)).size,
		).toBe(CANVAS_REFERENCE_ENVIRONMENTS.length);
		expect(CANVAS_REFERENCE_ENVIRONMENTS.map(({ tier }) => tier)).toEqual(
			expect.arrayContaining([
				"desktop-primary",
				"desktop-low-tier",
				"headless-core",
				"touch-primary",
			]),
		);
		const browsers = CANVAS_REFERENCE_ENVIRONMENTS.flatMap(
			({ browsers: environmentBrowsers }) => environmentBrowsers,
		).join(" ");
		expect(browsers).toContain("Chromium");
		expect(browsers).toContain("Firefox");
		expect(browsers).toContain("WebKit");
		expect(browsers).toContain("Mobile Safari");
	});

	it("names and versions the required document scales and content profiles", () => {
		expect(
			new Set(CANVAS_REFERENCE_DOCUMENT_FIXTURES.map(({ id }) => id)).size,
		).toBe(CANVAS_REFERENCE_DOCUMENT_FIXTURES.length);
		expect(
			CANVAS_REFERENCE_DOCUMENT_FIXTURES.map(({ scale }) => scale).join(" "),
		).toMatch(/100 content nodes.*1,000 content nodes.*5,000 content nodes/);
		expect(
			CANVAS_REFERENCE_DOCUMENT_FIXTURES.map(({ profile }) => profile),
		).toEqual(
			expect.arrayContaining([
				"balanced",
				"component-heavy",
				"image-heavy",
				"text-heavy",
			]),
		);
		for (const fixture of CANVAS_REFERENCE_DOCUMENT_FIXTURES) {
			expect(fixture.version).toBeGreaterThan(0);
			expect(fixture.source.length).toBeGreaterThan(0);
			expect(canvasReferenceFixtureLabel(fixture.id)).toContain(fixture.id);
		}
	});

	it.each([
		"canvas-balanced-100-v1",
		"canvas-balanced-1000-v1",
		"canvas-balanced-5000-v1",
		"canvas-text-1000-v1",
		"canvas-image-1000-v1",
		"canvas-components-1000-v1",
	] as const)("builds a deterministic, schema-valid %s document", (id) => {
		const first = buildReferenceDocument(id);
		const second = buildReferenceDocument(id);
		expect(CanvasIRSchema.parse(first)).toEqual(first);
		expect(second).toEqual(first);
	});
});
