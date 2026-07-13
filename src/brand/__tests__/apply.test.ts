import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasFrameNode,
	CanvasRectNode,
	CanvasTextNode,
} from "../../ir/types.js";
import {
	applyBrandColors,
	normalizeTypography,
	replaceFonts,
	replaceLogoPlaceholders,
} from "../apply.js";
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
		typography: [
			{ id: "heading", name: "Heading", fontSize: 32, fontWeight: "700" },
		],
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

function findNode<T>(document: ReturnType<typeof makeDocument>, id: string): T {
	const node = document.pages[0]?.root.children.find((n) => n.id === id);
	if (!node) throw new Error(`node ${id} not found`);
	return node as T;
}

describe("applyBrandColors", () => {
	it("links a literal fill matching a brand color to a BrandTokenRef", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#2563eb",
		});
		const document = makeDocument([rect]);
		const result = applyBrandColors(document, makeBrandKit());

		expect(result.report.affectedNodeIds).toEqual(["r1"]);
		expect(result.command).not.toBeNull();
		expect(result.command?.commands).toHaveLength(1);
		const updated = findNode<CanvasRectNode>(result.document, "r1");
		expect(updated.fill).toEqual({
			type: "brand-token",
			tokenType: "color",
			id: "primary",
		});
	});

	it("leaves a non-matching literal fill untouched and returns a null command", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#111111",
		});
		const document = makeDocument([rect]);
		const result = applyBrandColors(document, makeBrandKit());

		expect(result.report.affectedNodeIds).toEqual([]);
		expect(result.command).toBeNull();
		const updated = findNode<CanvasRectNode>(result.document, "r1");
		expect(updated.fill).toBe("#111111");
	});

	it("does not mutate a locked node's fill by default", () => {
		const rect = {
			...createRect({
				id: "r1",
				bounds: { width: 10, height: 10 },
				fill: "#2563eb",
			}),
			locked: true,
		};
		const document = makeDocument([rect]);
		const result = applyBrandColors(document, makeBrandKit());

		expect(result.report.affectedNodeIds).toEqual([]);
		expect(result.report.skippedLockedNodeIds).toEqual(["r1"]);
		const updated = findNode<CanvasRectNode>(result.document, "r1");
		expect(updated.fill).toBe("#2563eb");
	});

	it("mutates a locked node when includeLocked is set", () => {
		const rect = {
			...createRect({
				id: "r1",
				bounds: { width: 10, height: 10 },
				fill: "#2563eb",
			}),
			locked: true,
		};
		const document = makeDocument([rect]);
		const result = applyBrandColors(document, makeBrandKit(), {
			includeLocked: true,
		});

		expect(result.report.affectedNodeIds).toEqual(["r1"]);
	});

	it("is a pure function (never mutates the input document)", () => {
		const rect = createRect({
			id: "r1",
			bounds: { width: 10, height: 10 },
			fill: "#2563eb",
		});
		const document = makeDocument([rect]);
		const before = JSON.parse(JSON.stringify(document));
		applyBrandColors(document, makeBrandKit());
		expect(document).toEqual(before);
	});
});

describe("replaceFonts", () => {
	it("links a literal fontFamily matching a brand font to a BrandTokenRef", () => {
		const text = createText({
			id: "t1",
			bounds: { width: 100, height: 20 },
			text: "Hi",
			fontFamily: "Inter",
		});
		const document = makeDocument([text]);
		const result = replaceFonts(document, makeBrandKit());

		expect(result.report.affectedNodeIds).toEqual(["t1"]);
		const updated = findNode<CanvasTextNode>(result.document, "t1");
		expect(updated.fontFamily).toEqual({
			type: "brand-token",
			tokenType: "font",
			id: "body",
		});
	});

	it("leaves a non-matching font untouched", () => {
		const text = createText({
			id: "t1",
			bounds: { width: 100, height: 20 },
			text: "Hi",
			fontFamily: "Comic Sans",
		});
		const document = makeDocument([text]);
		const result = replaceFonts(document, makeBrandKit());
		expect(result.report.affectedNodeIds).toEqual([]);
	});
});

describe("replaceLogoPlaceholders", () => {
	it("fills an empty logo placeholder with the brand's logo", () => {
		const frame = createFrame({
			id: "f1",
			bounds: { width: 100, height: 100 },
			placeholder: { kind: "logo" },
		});
		const document = makeDocument([frame]);
		const brandKit = makeBrandKit({
			logos: [
				{ id: "logo1", name: "Wordmark", uri: "asset://logo1", kind: "logo" },
			],
		});
		const result = replaceLogoPlaceholders(document, brandKit);

		expect(result.report.affectedNodeIds).toEqual(["f1"]);
		const updated = findNode<CanvasFrameNode>(result.document, "f1");
		expect(updated.placeholder?.assetToken).toEqual({
			type: "brand-token",
			tokenType: "logo",
			id: "logo1",
		});
	});

	it("leaves a placeholder that already has an assetId alone", () => {
		const frame = createFrame({
			id: "f1",
			bounds: { width: 100, height: 100 },
			placeholder: { kind: "logo", assetId: "already-set" },
		});
		const document = makeDocument([frame]);
		const brandKit = makeBrandKit({
			logos: [
				{ id: "logo1", name: "Wordmark", uri: "asset://logo1", kind: "logo" },
			],
		});
		const result = replaceLogoPlaceholders(document, brandKit);
		expect(result.report.affectedNodeIds).toEqual([]);
	});

	it("is a no-op when the brand kit has no logos", () => {
		const frame = createFrame({
			id: "f1",
			bounds: { width: 100, height: 100 },
			placeholder: { kind: "logo" },
		});
		const document = makeDocument([frame]);
		const result = replaceLogoPlaceholders(document, makeBrandKit());
		expect(result.report.affectedNodeIds).toEqual([]);
	});
});

describe("normalizeTypography", () => {
	it("applies the first typography preset's fontSize/fontWeight to every text node", () => {
		const text = createText({
			id: "t1",
			bounds: { width: 100, height: 20 },
			text: "Hi",
			fontSize: 12,
		});
		const document = makeDocument([text]);
		const result = normalizeTypography(document, makeBrandKit());

		expect(result.report.affectedNodeIds).toEqual(["t1"]);
		const updated = findNode<CanvasTextNode>(result.document, "t1");
		expect(updated.fontSize).toBe(32);
		expect(updated.fontWeight).toBe("700");
	});

	it("selects a specific preset by id when given", () => {
		const text = createText({
			id: "t1",
			bounds: { width: 100, height: 20 },
			text: "Hi",
		});
		const document = makeDocument([text]);
		const brandKit = makeBrandKit({
			typography: [
				{ id: "heading", name: "Heading", fontSize: 32 },
				{ id: "caption", name: "Caption", fontSize: 10 },
			],
		});
		const result = normalizeTypography(document, brandKit, {
			presetId: "caption",
		});
		const updated = findNode<CanvasTextNode>(result.document, "t1");
		expect(updated.fontSize).toBe(10);
	});

	it("is a no-op when the brand kit has no typography presets", () => {
		const text = createText({
			id: "t1",
			bounds: { width: 100, height: 20 },
			text: "Hi",
		});
		const document = makeDocument([text]);
		const result = normalizeTypography(
			document,
			makeBrandKit({ typography: [] }),
		);
		expect(result.report.affectedNodeIds).toEqual([]);
	});
});
