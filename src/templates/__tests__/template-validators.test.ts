import { describe, expect, it } from "vitest";
import { createCanvasIR } from "../../ir/builders.js";
import type { CanvasTemplateDefinition } from "../types.js";
import {
	CanvasSizePresetSchema,
	CanvasTemplateDefinitionSchema,
	TemplateSlotSchema,
	TemplateVariableSchema,
} from "../validators.js";

const FIXED_NOW = () => "2026-07-13T00:00:00.000Z";

function makeDocument() {
	return createCanvasIR({ id: "doc1", title: "Poster", now: FIXED_NOW });
}

function makeMinimalTemplate(): CanvasTemplateDefinition {
	return {
		id: "tpl-poster",
		version: "1",
		title: "Event Poster",
		category: "social",
		tags: ["poster"],
		supportedSizes: [],
		document: makeDocument(),
		variables: [],
		editableSlots: [],
		lockedNodeIds: [],
	};
}

describe("CanvasSizePresetSchema", () => {
	it("accepts a minimal preset", () => {
		const preset = {
			id: "instagram-post",
			version: "1",
			label: "Instagram Post",
			width: 1080,
			height: 1080,
			unit: "px",
		};
		expect(CanvasSizePresetSchema.safeParse(preset).success).toBe(true);
	});

	it("accepts dpi and safeArea", () => {
		const preset = {
			id: "a4-flyer",
			version: "1",
			label: "A4 Flyer",
			width: 210,
			height: 297,
			unit: "mm",
			dpi: 300,
			safeArea: { top: 5, right: 5, bottom: 5, left: 5 },
		};
		expect(CanvasSizePresetSchema.safeParse(preset).success).toBe(true);
	});

	it("rejects a non-positive width", () => {
		const preset = {
			id: "bad",
			version: "1",
			label: "Bad",
			width: 0,
			height: 100,
			unit: "px",
		};
		expect(CanvasSizePresetSchema.safeParse(preset).success).toBe(false);
	});
});

describe("TemplateSlotSchema", () => {
	it("accepts each of the six slot kinds", () => {
		for (const kind of [
			"text",
			"image",
			"logo",
			"frame",
			"color",
			"font",
		] as const) {
			const slot = { id: `slot-${kind}`, kind, nodeId: "n1" };
			expect(TemplateSlotSchema.safeParse(slot).success).toBe(true);
		}
	});

	it("rejects an unknown slot kind", () => {
		const slot = { id: "slot-bad", kind: "video", nodeId: "n1" };
		expect(TemplateSlotSchema.safeParse(slot).success).toBe(false);
	});
});

describe("TemplateVariableSchema", () => {
	it("accepts a variable with a default and required flag", () => {
		const variable = {
			id: "var-headline",
			label: "Headline",
			slotId: "slot-text",
			defaultValue: "Big Sale",
			required: true,
		};
		expect(TemplateVariableSchema.safeParse(variable).success).toBe(true);
	});
});

describe("CanvasTemplateDefinitionSchema", () => {
	it("validates a minimal template", () => {
		const result = CanvasTemplateDefinitionSchema.safeParse(
			makeMinimalTemplate(),
		);
		expect(result.success).toBe(true);
	});

	it("validates a template carrying every optional field", () => {
		const full: CanvasTemplateDefinition = {
			...makeMinimalTemplate(),
			previewAssetId: "asset1",
			requiredAssets: ["asset1"],
			supportedSizes: [
				{
					id: "instagram-post",
					version: "1",
					label: "Instagram Post",
					width: 1080,
					height: 1080,
					unit: "px",
				},
			],
			variables: [
				{ id: "var1", label: "Headline", slotId: "slot1", required: true },
			],
			editableSlots: [{ id: "slot1", kind: "text", nodeId: "n1" }],
			lockedNodeIds: ["n2"],
			license: { type: "cc-by", attribution: "AnvilKit" },
			source: { author: "AnvilKit", sourceUrl: "https://example.com" },
		};
		expect(CanvasTemplateDefinitionSchema.safeParse(full).success).toBe(true);
	});

	it("rejects a document that fails normal CanvasIR validation", () => {
		const invalid = {
			...makeMinimalTemplate(),
			document: { ...makeMinimalTemplate().document, version: "999" },
		};
		expect(CanvasTemplateDefinitionSchema.safeParse(invalid).success).toBe(
			false,
		);
	});

	it("keeps template-only fields off the document (no leakage)", () => {
		const result = CanvasTemplateDefinitionSchema.safeParse(
			makeMinimalTemplate(),
		);
		expect(result.success).toBe(true);
		if (result.success) {
			const documentKeys = Object.keys(result.data.document);
			for (const templateOnlyKey of [
				"category",
				"tags",
				"variables",
				"editableSlots",
				"lockedNodeIds",
			]) {
				expect(documentKeys).not.toContain(templateOnlyKey);
			}
		}
	});

	it("rejects a missing required array field (e.g. lockedNodeIds)", () => {
		const { lockedNodeIds: _omit, ...withoutLockedNodeIds } =
			makeMinimalTemplate();
		expect(
			CanvasTemplateDefinitionSchema.safeParse(withoutLockedNodeIds).success,
		).toBe(false);
	});
});
