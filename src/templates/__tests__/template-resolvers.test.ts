import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
} from "../../ir/builders.js";
import {
	isNodeLocked,
	resolveTemplateVariables,
	validateTemplateReferences,
} from "../resolvers.js";
import type { CanvasTemplateDefinition } from "../types.js";
import {
	TemplateColorSlotSchema,
	TemplateFontSlotSchema,
	TemplateFrameSlotSchema,
	TemplateImageSlotSchema,
	TemplateLogoSlotSchema,
	TemplateSlotSchema,
	TemplateTextSlotSchema,
} from "../validators.js";

const FIXED_NOW = () => "2026-07-13T00:00:00.000Z";

/** A document with two real nodes ("rect1", "rect2") for referential checks. */
function makeDocumentWithNodes() {
	const rect1 = createRect({
		id: "rect1",
		bounds: { width: 100, height: 100 },
	});
	const rect2 = createRect({ id: "rect2", bounds: { width: 50, height: 50 } });
	const page = createPage({
		id: "page1",
		root: createGroup({ children: [rect1, rect2] }),
	});
	return createCanvasIR({ id: "doc1", pages: [page], now: FIXED_NOW });
}

function makeTemplate(
	overrides: Partial<CanvasTemplateDefinition> = {},
): CanvasTemplateDefinition {
	return {
		id: "tpl1",
		version: "1",
		title: "Poster",
		category: "social",
		tags: [],
		supportedSizes: [],
		document: makeDocumentWithNodes(),
		variables: [],
		editableSlots: [],
		lockedNodeIds: [],
		...overrides,
	};
}

describe("TemplateSlotSchema (discriminated union)", () => {
	it("accepts each of the six slot kinds via their own schema", () => {
		expect(
			TemplateTextSlotSchema.safeParse({ id: "s1", kind: "text", nodeId: "n1" })
				.success,
		).toBe(true);
		expect(
			TemplateImageSlotSchema.safeParse({
				id: "s1",
				kind: "image",
				nodeId: "n1",
			}).success,
		).toBe(true);
		expect(
			TemplateLogoSlotSchema.safeParse({ id: "s1", kind: "logo", nodeId: "n1" })
				.success,
		).toBe(true);
		expect(
			TemplateFrameSlotSchema.safeParse({
				id: "s1",
				kind: "frame",
				nodeId: "n1",
			}).success,
		).toBe(true);
		expect(
			TemplateColorSlotSchema.safeParse({
				id: "s1",
				kind: "color",
				nodeId: "n1",
			}).success,
		).toBe(true);
		expect(
			TemplateFontSlotSchema.safeParse({ id: "s1", kind: "font", nodeId: "n1" })
				.success,
		).toBe(true);
	});

	it("dispatches through the combined discriminated union", () => {
		for (const kind of [
			"text",
			"image",
			"logo",
			"frame",
			"color",
			"font",
		] as const) {
			expect(
				TemplateSlotSchema.safeParse({ id: `s-${kind}`, kind, nodeId: "n1" })
					.success,
			).toBe(true);
		}
	});

	it("rejects an unknown slot kind", () => {
		expect(
			TemplateSlotSchema.safeParse({ id: "s1", kind: "video", nodeId: "n1" })
				.success,
		).toBe(false);
	});

	it("accepts a color slot's optional property field", () => {
		const result = TemplateColorSlotSchema.safeParse({
			id: "s1",
			kind: "color",
			nodeId: "n1",
			property: "stroke",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.property).toBe("stroke");
		}
	});

	it("rejects an invalid color slot property", () => {
		const result = TemplateColorSlotSchema.safeParse({
			id: "s1",
			kind: "color",
			nodeId: "n1",
			property: "opacity",
		});
		expect(result.success).toBe(false);
	});
});

describe("validateTemplateReferences", () => {
	it("returns no issues when every slot/locked node exists", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot1", kind: "text", nodeId: "rect1" }],
			lockedNodeIds: ["rect2"],
		});
		expect(validateTemplateReferences(template)).toEqual([]);
	});

	it("reports a slot referencing a non-existent node", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot1", kind: "text", nodeId: "does-not-exist" }],
		});
		expect(validateTemplateReferences(template)).toEqual([
			{
				code: "slot-node-not-found",
				id: "slot1",
				nodeId: "does-not-exist",
			},
		]);
	});

	it("reports a locked-node-id referencing a non-existent node", () => {
		const template = makeTemplate({ lockedNodeIds: ["does-not-exist"] });
		expect(validateTemplateReferences(template)).toEqual([
			{
				code: "locked-node-not-found",
				id: "does-not-exist",
				nodeId: "does-not-exist",
			},
		]);
	});

	it("reports multiple issues at once", () => {
		const template = makeTemplate({
			editableSlots: [{ id: "slot1", kind: "text", nodeId: "missing-a" }],
			lockedNodeIds: ["missing-b"],
		});
		expect(validateTemplateReferences(template)).toHaveLength(2);
	});
});

describe("isNodeLocked", () => {
	it("is true for a locked node id", () => {
		const template = makeTemplate({ lockedNodeIds: ["rect1"] });
		expect(isNodeLocked(template, "rect1")).toBe(true);
	});

	it("is false for a node id not in lockedNodeIds", () => {
		const template = makeTemplate({ lockedNodeIds: ["rect1"] });
		expect(isNodeLocked(template, "rect2")).toBe(false);
	});
});

describe("resolveTemplateVariables", () => {
	it("uses the supplied value when present", () => {
		const template = makeTemplate({
			variables: [{ id: "var1", label: "Headline", slotId: "slot1" }],
		});
		const result = resolveTemplateVariables(template, { var1: "Big Sale" });
		expect(result.values).toEqual({ var1: "Big Sale" });
		expect(result.warnings).toEqual([]);
	});

	it("falls back to defaultValue when no value is supplied", () => {
		const template = makeTemplate({
			variables: [
				{
					id: "var1",
					label: "Headline",
					slotId: "slot1",
					defaultValue: "Default Headline",
				},
			],
		});
		const result = resolveTemplateVariables(template, {});
		expect(result.values).toEqual({ var1: "Default Headline" });
		expect(result.warnings).toEqual([]);
	});

	it("warns (does not throw) for a required variable with no value or default", () => {
		const template = makeTemplate({
			variables: [
				{ id: "var1", label: "Headline", slotId: "slot1", required: true },
			],
		});
		const result = resolveTemplateVariables(template, {});
		expect(result.values).toEqual({});
		expect(result.warnings).toEqual([
			{
				code: "required-variable-missing",
				variableId: "var1",
				slotId: "slot1",
			},
		]);
	});

	it("silently omits a non-required variable with no value or default", () => {
		const template = makeTemplate({
			variables: [{ id: "var1", label: "Optional", slotId: "slot1" }],
		});
		const result = resolveTemplateVariables(template, {});
		expect(result.values).toEqual({});
		expect(result.warnings).toEqual([]);
	});
});
