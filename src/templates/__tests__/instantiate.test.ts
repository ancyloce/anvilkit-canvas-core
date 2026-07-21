import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createImage,
	createLine,
	createPage,
	createRect,
	createRichText,
	createText,
} from "../../ir/builders.js";
import { instantiateTemplate } from "../instantiate.js";
import type { CanvasTemplateDefinition } from "../types.js";

/** A deterministic id/clock factory pair, freshly instantiated per test call. */
function makeDeterministicFactories() {
	let counter = 0;
	return {
		idFactory: () => `id-${counter++}`,
		nowFactory: () => "2026-07-13T00:00:00.000Z",
	};
}

function makeDocument() {
	const text1 = createText({
		id: "text1",
		bounds: { width: 200, height: 40 },
		text: "Placeholder Headline",
	});
	const image1 = createImage({
		id: "image1",
		bounds: { width: 300, height: 300 },
		assetId: "placeholder-asset",
	});
	const rect1 = createRect({
		id: "rect1",
		bounds: { width: 50, height: 50 },
		fill: "#cccccc",
	});
	const line1 = createLine({
		id: "line1",
		points: [0, 0, 100, 0],
		stroke: "#000000",
	});
	const page = createPage({
		id: "page1",
		root: createGroup({ children: [text1, image1, rect1, line1] }),
	});
	return createCanvasIR({
		id: "doc1",
		pages: [page],
		now: () => "2026-01-01T00:00:00.000Z",
	});
}

function makeTemplate(
	overrides: Partial<CanvasTemplateDefinition> = {},
): CanvasTemplateDefinition {
	return {
		id: "tpl-poster",
		version: "1",
		title: "Poster",
		category: "social",
		tags: [],
		supportedSizes: [],
		document: makeDocument(),
		variables: [],
		editableSlots: [],
		lockedNodeIds: [],
		...overrides,
	};
}

describe("instantiateTemplate — determinism and identity", () => {
	it("produces deep-equal output across two calls with fresh, identically-seeded factories", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot-headline", kind: "text", nodeId: "text1" }],
			variables: [
				{ id: "var-headline", label: "Headline", slotId: "slot-headline" },
			],
		});
		const first = instantiateTemplate(template, {
			variables: { "var-headline": "Big Sale" },
			...makeDeterministicFactories(),
		});
		const second = instantiateTemplate(template, {
			variables: { "var-headline": "Big Sale" },
			...makeDeterministicFactories(),
		});
		expect(first.document).toEqual(second.document);
		expect(first.command).toEqual(second.command);
		expect(first.warnings).toEqual(second.warnings);
	});

	it("produces an identical result whether or not the template carries marketplace/governance metadata (FR-082, canvas-m6-003)", () => {
		const bare = makeTemplate();
		const withMetadata = makeTemplate({
			license: {
				type: "cc-by",
				attribution: "AnvilKit",
				attributionRequired: true,
				redistributable: true,
				redistributionTerms: "Attribution required.",
			},
			source: { author: "AnvilKit", sourceUrl: "https://example.com" },
			assetAttributions: {
				"placeholder-asset": {
					author: "Jane Doe",
					credit: "Photo by Jane Doe",
				},
			},
		});
		const resultBare = instantiateTemplate(bare, makeDeterministicFactories());
		const resultWithMetadata = instantiateTemplate(
			withMetadata,
			makeDeterministicFactories(),
		);
		expect(resultWithMetadata.document).toEqual(resultBare.document);
		expect(resultWithMetadata.command).toEqual(resultBare.command);
		expect(resultWithMetadata.warnings).toEqual(resultBare.warnings);
	});

	it("sets documentKind to template-instance and validates as normal CanvasIR", () => {
		const result = instantiateTemplate(
			makeTemplate(),
			makeDeterministicFactories(),
		);
		expect(result.document.documentKind).toBe("template-instance");
		expect(result.document.version).toBe("2");
	});

	it("gives every page and node a fresh id (no collision with the template's own ids)", () => {
		const result = instantiateTemplate(
			makeTemplate(),
			makeDeterministicFactories(),
		);
		expect(result.document.pages[0]?.id).not.toBe("page1");
		const root = result.document.pages[0]?.root;
		expect(root?.children.map((n) => n.id)).not.toEqual(
			expect.arrayContaining(["text1", "image1", "rect1", "line1"]),
		);
	});

	it("returns a batch command with one page.create per instantiated page", () => {
		const result = instantiateTemplate(
			makeTemplate(),
			makeDeterministicFactories(),
		);
		expect(result.command.type).toBe("batch");
		expect(result.command.commands).toHaveLength(1);
		expect(result.command.commands[0]).toEqual({
			type: "page.create",
			page: result.document.pages[0],
		});
	});
});

describe("instantiateTemplate — variable substitution", () => {
	it("applies a supplied value to its slot's target node", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot-headline", kind: "text", nodeId: "text1" }],
			variables: [
				{ id: "var-headline", label: "Headline", slotId: "slot-headline" },
			],
		});
		const result = instantiateTemplate(template, {
			variables: { "var-headline": "Big Sale" },
			...makeDeterministicFactories(),
		});
		const textNode = result.document.pages[0]?.root.children.find(
			(n) => n.type === "text",
		);
		expect(textNode?.type === "text" && textNode.text).toBe("Big Sale");
	});

	it("writes a text slot's value into exactly one span, not every span (C-5)", () => {
		const richText = createRichText({
			id: "rt1",
			bounds: { width: 200, height: 80 },
			paragraphs: [
				{ spans: [{ text: "Hello " }, { text: "World" }] },
				{ spans: [{ text: "Second line" }] },
			],
		});
		const page = createPage({
			id: "page1",
			root: createGroup({ children: [richText] }),
		});
		const document = createCanvasIR({
			id: "doc1",
			pages: [page],
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const template = makeTemplate({
			document,
			editableSlots: [{ id: "slot-headline", kind: "text", nodeId: "rt1" }],
			variables: [
				{ id: "var-headline", label: "Headline", slotId: "slot-headline" },
			],
		});
		const result = instantiateTemplate(template, {
			variables: { "var-headline": "Big Sale" },
			...makeDeterministicFactories(),
		});
		const node = result.document.pages[0]?.root.children.find(
			(n) => n.type === "rich-text",
		);
		if (node?.type !== "rich-text") throw new Error("expected rich-text node");
		const allText = node.paragraphs.flatMap((p) => p.spans.map((s) => s.text));
		// Before the fix this was ["Big Sale", "Big Sale", "Big Sale"] —
		// the value duplicated into every span across both paragraphs.
		expect(allText).toEqual(["Big Sale", "", ""]);
	});

	it("falls back to defaultValue when no value is supplied", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot-image", kind: "image", nodeId: "image1" }],
			variables: [
				{
					id: "var-image",
					label: "Image",
					slotId: "slot-image",
					defaultValue: "default-asset",
				},
			],
		});
		const result = instantiateTemplate(template, makeDeterministicFactories());
		const imageNode = result.document.pages[0]?.root.children.find(
			(n) => n.type === "image",
		);
		expect(imageNode?.type === "image" && imageNode.assetId).toBe(
			"default-asset",
		);
		expect(result.warnings).toEqual([]);
	});

	it("warns (does not throw) and leaves the node unchanged for a required variable with no value or default", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot-headline", kind: "text", nodeId: "text1" }],
			variables: [
				{
					id: "var-headline",
					label: "Headline",
					slotId: "slot-headline",
					required: true,
				},
			],
		});
		const result = instantiateTemplate(template, makeDeterministicFactories());
		const textNode = result.document.pages[0]?.root.children.find(
			(n) => n.type === "text",
		);
		expect(textNode?.type === "text" && textNode.text).toBe(
			"Placeholder Headline",
		);
		expect(result.warnings).toEqual([
			{
				code: "required-variable-missing",
				variableId: "var-headline",
				slotId: "slot-headline",
			},
		]);
	});

	it("never mutates a locked node even when its slot has a resolved value", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot-accent", kind: "color", nodeId: "rect1" }],
			variables: [
				{
					id: "var-accent",
					label: "Accent",
					slotId: "slot-accent",
					defaultValue: "#ff0000",
				},
			],
			lockedNodeIds: ["rect1"],
		});
		const result = instantiateTemplate(template, makeDeterministicFactories());
		const rectNode = result.document.pages[0]?.root.children.find(
			(n) => n.type === "rect",
		);
		expect(rectNode?.type === "rect" && rectNode.fill).toBe("#cccccc");
		expect(result.warnings).toEqual([]);
	});

	it("applies a color slot's value to a rect's fill", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot-accent", kind: "color", nodeId: "rect1" }],
			variables: [
				{
					id: "var-accent",
					label: "Accent",
					slotId: "slot-accent",
					defaultValue: "#ff0000",
				},
			],
		});
		const result = instantiateTemplate(template, makeDeterministicFactories());
		const rectNode = result.document.pages[0]?.root.children.find(
			(n) => n.type === "rect",
		);
		expect(rectNode?.type === "rect" && rectNode.fill).toBe("#ff0000");
	});

	it("warns when a variable references an unknown slot id", () => {
		const template = makeTemplate({
			variables: [
				{
					id: "var-orphan",
					label: "Orphan",
					slotId: "slot-does-not-exist",
					defaultValue: "x",
				},
			],
		});
		const result = instantiateTemplate(template, makeDeterministicFactories());
		expect(result.warnings).toEqual([
			{
				code: "variable-slot-not-found",
				variableId: "var-orphan",
				slotId: "slot-does-not-exist",
			},
		]);
	});

	it("warns when a slot references a node id absent from the document", () => {
		const template = makeTemplate({
			editableSlots: [
				{ id: "slot-ghost", kind: "text", nodeId: "no-such-node" },
			],
			variables: [
				{
					id: "var-ghost",
					label: "Ghost",
					slotId: "slot-ghost",
					defaultValue: "x",
				},
			],
		});
		const result = instantiateTemplate(template, makeDeterministicFactories());
		expect(result.warnings).toEqual([
			{
				code: "slot-node-not-found",
				variableId: "var-ghost",
				slotId: "slot-ghost",
				nodeId: "no-such-node",
			},
		]);
	});

	it("warns for an unsupported slot-kind/node-kind combination", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot-bad", kind: "color", nodeId: "line1" }],
			variables: [
				{
					id: "var-bad",
					label: "Bad",
					slotId: "slot-bad",
					defaultValue: "#ff0000",
				},
			],
		});
		const result = instantiateTemplate(template, makeDeterministicFactories());
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.code).toBe("unsupported-slot-mutation");
	});
});
