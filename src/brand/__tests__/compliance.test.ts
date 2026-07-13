import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { generateBrandComplianceReport } from "../compliance.js";
import type { BrandKitDefinition } from "../types.js";

const FIXED_NOW = () => "2026-07-13T00:00:00.000Z";

function makeBrandKit(
	overrides: Partial<BrandKitDefinition> = {},
): BrandKitDefinition {
	return {
		id: "kit1",
		name: "Acme",
		logos: [],
		colors: [{ id: "primary", name: "Primary", value: "#2563EB" }],
		fonts: [{ id: "body", name: "Body", family: "Inter" }],
		typography: [],
		rules: [],
		...overrides,
	};
}

function makeDocument(nodes: Parameters<typeof createGroup>[0]["children"]) {
	const page = createPage({
		id: "page1",
		root: createGroup({ children: nodes }),
	});
	return createCanvasIR({ id: "doc1", pages: [page], now: FIXED_NOW });
}

describe("generateBrandComplianceReport", () => {
	it("reports no issues for an on-brand document", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#2563eb",
		});
		const document = makeDocument([rect]);
		expect(
			generateBrandComplianceReport(document, makeBrandKit()).issues,
		).toEqual([]);
	});

	it("flags an off-brand literal color when the kit defines colors", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#111111",
		});
		const document = makeDocument([rect]);
		const report = generateBrandComplianceReport(document, makeBrandKit());
		expect(report.issues).toEqual([
			{
				nodeId: "r1",
				code: "off-brand-color",
				property: "fill",
				value: "#111111",
			},
		]);
	});

	it("does not flag off-brand colors when the kit defines no colors at all", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#111111",
		});
		const document = makeDocument([rect]);
		const report = generateBrandComplianceReport(
			document,
			makeBrandKit({ colors: [] }),
		);
		expect(report.issues).toEqual([]);
	});

	it("flags a forbidden color even if no colors are configured", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#ff0000",
		});
		const document = makeDocument([rect]);
		const brandKit = makeBrandKit({
			colors: [],
			rules: [{ id: "rule1", kind: "forbidden-color", value: "#ff0000" }],
		});
		const report = generateBrandComplianceReport(document, brandKit);
		expect(report.issues).toEqual([
			{
				nodeId: "r1",
				code: "forbidden-color",
				property: "fill",
				value: "#ff0000",
			},
		]);
	});

	it("does not flag a literal matched by an allowed-color rule", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#111111",
		});
		const document = makeDocument([rect]);
		const brandKit = makeBrandKit({
			rules: [{ id: "rule1", kind: "allowed-color", value: "#111111" }],
		});
		const report = generateBrandComplianceReport(document, brandKit);
		expect(report.issues).toEqual([]);
	});

	it("flags an unresolved color token", () => {
		const rect = {
			...createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
			fill: {
				type: "brand-token" as const,
				tokenType: "color" as const,
				id: "missing",
			},
		};
		const document = makeDocument([rect]);
		const report = generateBrandComplianceReport(document, makeBrandKit());
		expect(report.issues).toEqual([
			{
				nodeId: "r1",
				code: "unresolved-color-token",
				property: "fill",
				value: "missing",
			},
		]);
	});

	it("flags an off-brand font on a text node", () => {
		const text = createText({
			id: "t1",
			bounds: { width: 100, height: 20 },
			text: "Hi",
			fontFamily: "Comic Sans",
		});
		const document = makeDocument([text]);
		const report = generateBrandComplianceReport(document, makeBrandKit());
		expect(report.issues).toContainEqual({
			nodeId: "t1",
			code: "off-brand-font",
			property: "fontFamily",
			value: "Comic Sans",
		});
	});

	it("never mutates the input document", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#111111",
		});
		const document = makeDocument([rect]);
		const before = JSON.parse(JSON.stringify(document));
		generateBrandComplianceReport(document, makeBrandKit());
		expect(document).toEqual(before);
	});
});
