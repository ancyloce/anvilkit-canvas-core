import { describe, expect, it } from "vitest";
import { applyCommands } from "../../commands/transaction.js";
import {
	createCanvasIR,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR } from "../../ir/types.js";
import { CanvasIRSchema, CanvasPageSchema } from "../../ir/validators.js";
import {
	buildCampaignExportJobRequest,
	resizeToVariants,
} from "../resize-to-variants.js";
import type { CanvasSizePreset } from "../types.js";

/** A deterministic id factory, freshly instantiated per test call. */
function makeIdFactory() {
	let counter = 0;
	return () => `id-${counter++}`;
}

function makeDocument(): CanvasIR {
	const page = createPage({ id: "source-page", name: "Source" });
	let ir = createCanvasIR({
		id: "doc1",
		title: "Doc",
		pages: [page],
		now: () => "2026-07-13T00:00:00.000Z",
	});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createRect({ id: "rect1", bounds: { width: 100, height: 50 } }),
	});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createText({
			id: "text1",
			bounds: { width: 100, height: 20 },
			text: "Headline",
		}),
	});
	return ir;
}

const instagramPost: CanvasSizePreset = {
	id: "instagram-post",
	version: "1",
	label: "Instagram Post",
	width: 1080,
	height: 1080,
	unit: "px",
	dpi: 72,
};

const youtubeThumbnail: CanvasSizePreset = {
	id: "youtube-thumbnail",
	version: "1",
	label: "YouTube Thumbnail",
	width: 1280,
	height: 720,
	unit: "px",
};

describe("resizeToVariants", () => {
	it("produces one new page per preset, sized to that preset", () => {
		const document = makeDocument();
		const { pages } = resizeToVariants(document, "source-page", [
			instagramPost,
			youtubeThumbnail,
		]);
		expect(pages).toHaveLength(2);
		expect(pages[0]?.size).toEqual({
			width: 1080,
			height: 1080,
			unit: "px",
			dpi: 72,
		});
		expect(pages[1]?.size).toEqual({
			width: 1280,
			height: 720,
			unit: "px",
		});
	});

	it("stamps variantSource with the source page id and preset id/version", () => {
		const document = makeDocument();
		const { pages } = resizeToVariants(document, "source-page", [
			instagramPost,
		]);
		expect(pages[0]?.variantSource).toEqual({
			sourcePageId: "source-page",
			presetId: "instagram-post",
			presetVersion: "1",
		});
	});

	it("copies the source page's content into each variant, with fresh node ids", () => {
		const document = makeDocument();
		const { pages } = resizeToVariants(document, "source-page", [
			instagramPost,
		]);
		const variant = pages[0];
		expect(variant?.root.children).toHaveLength(2);
		const variantIds = variant?.root.children.map((n) => n.id) ?? [];
		expect(variantIds).not.toContain("rect1");
		expect(variantIds).not.toContain("text1");
		expect(new Set(variantIds).size).toBe(variantIds.length);
	});

	it("gives every variant page a fresh id distinct from the source and each other", () => {
		const document = makeDocument();
		const { pages } = resizeToVariants(document, "source-page", [
			instagramPost,
			youtubeThumbnail,
		]);
		const ids = pages.map((p) => p.id);
		expect(ids).not.toContain("source-page");
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("uses the injected idFactory deterministically", () => {
		const document = makeDocument();
		const { pages } = resizeToVariants(
			document,
			"source-page",
			[instagramPost],
			{ idFactory: makeIdFactory() },
		);
		expect(pages[0]?.id).toBe("id-3"); // root group + 2 children remapped first, then the page id
	});

	it("does not mutate the input document", () => {
		const document = makeDocument();
		const before = structuredClone(document);
		resizeToVariants(document, "source-page", [instagramPost]);
		expect(document).toEqual(before);
	});

	it("throws for an unknown sourcePageId", () => {
		const document = makeDocument();
		expect(() => resizeToVariants(document, "nope", [instagramPost])).toThrow(
			/no page with id/,
		);
	});

	it("returns a single reversible batch command with one page.create per preset", () => {
		const document = makeDocument();
		const { pages, command } = resizeToVariants(document, "source-page", [
			instagramPost,
			youtubeThumbnail,
		]);
		expect(command.type).toBe("batch");
		expect(command.commands).toHaveLength(2);
		expect(command.commands.every((c) => c.type === "page.create")).toBe(true);
		const { ir, inverse } = applyCommands(document, command.commands);
		expect(ir.pages).toHaveLength(3);
		expect(ir.pages.map((p) => p.id)).toEqual([
			"source-page",
			...pages.map((p) => p.id),
		]);
		expect(inverse.type).toBe("batch");
	});

	it("each generated page validates as normal Canvas IR", () => {
		const document = makeDocument();
		const { pages, command } = resizeToVariants(document, "source-page", [
			instagramPost,
			youtubeThumbnail,
		]);
		for (const page of pages) {
			expect(CanvasPageSchema.safeParse(page).success).toBe(true);
		}
		const { ir } = applyCommands(document, command.commands);
		expect(CanvasIRSchema.safeParse(ir).success).toBe(true);
	});

	it("returns an empty result for an empty preset list", () => {
		const document = makeDocument();
		const { pages, command } = resizeToVariants(document, "source-page", []);
		expect(pages).toEqual([]);
		expect(command.commands).toEqual([]);
	});
});

describe("buildCampaignExportJobRequest", () => {
	it("builds one request with a page + variant entry per generated page", () => {
		const document = makeDocument();
		const { pages, command } = resizeToVariants(document, "source-page", [
			instagramPost,
			youtubeThumbnail,
		]);
		const { ir } = applyCommands(document, command.commands);
		const request = buildCampaignExportJobRequest(ir, pages, {
			id: "job-1",
			format: "png",
			options: {},
		});

		expect(request.id).toBe("job-1");
		expect(request.format).toBe("png");
		expect(request.source).toEqual({ document: ir });
		expect(request.pages).toEqual(pages.map((p) => p.id));
		expect(request.variants).toEqual([
			{
				presetId: "instagram-post",
				pageId: pages[0]?.id,
				label: pages[0]?.name,
			},
			{
				presetId: "youtube-thumbnail",
				pageId: pages[1]?.id,
				label: pages[1]?.name,
			},
		]);
	});

	it("omits presetId/label when a page carries neither", () => {
		const document = makeDocument();
		const bare = { ...document.pages[0], id: "bare-page", name: undefined };
		const request = buildCampaignExportJobRequest(
			document,
			[bare as (typeof document.pages)[number]],
			{ id: "job-2", format: "svg", options: {} },
		);
		expect(request.variants).toEqual([{ pageId: "bare-page" }]);
	});
});
