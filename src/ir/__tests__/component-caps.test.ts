import { describe, expect, it } from "vitest";
import {
	MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT,
	MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
	MAX_COMPONENT_NESTED_DEPTH,
	MAX_COMPONENT_OVERRIDES_PER_INSTANCE,
	MAX_COMPONENT_PROPERTIES_PER_COMPONENT,
	MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE,
	MAX_COMPONENT_RICH_SPANS_PER_PARAGRAPH,
	MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION,
	MAX_COMPONENT_TEXT_OVERRIDE_CHARS,
	MAX_DOCUMENT_NODES,
	MAX_TREE_DEPTH,
} from "../../limits.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverride,
	CanvasComponentProperty,
	CanvasNode,
} from "../types.js";
import {
	CanvasComponentInstanceNodeSchema,
	CanvasComponentRegistrySchema,
	CanvasTextOverrideValueSchema,
} from "../validators.js";

/**
 * M1-07 (plan 0023, D-3): every resource cap is an exported constant with a
 * boundary case that passes and an over-limit case that rejects — no inline
 * literals. Depth and expansion caps are enforced by the M2 resolver/graph;
 * here their VALUES and anchors are pinned so a drive-by edit is visible.
 */

function rect(id: string): CanvasNode {
	return {
		id,
		type: "rect",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 10, height: 10 },
		zIndex: 0,
	} as CanvasNode;
}

function groupWithChildren(id: string, childCount: number): CanvasNode {
	return {
		id,
		type: "group",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 10, height: 10 },
		zIndex: 0,
		children: Array.from({ length: childCount }, (_, i) => rect(`${id}-c${i}`)),
	} as CanvasNode;
}

function definition(
	id: string,
	overridesPart: Partial<CanvasComponentDefinition> = {},
): CanvasComponentDefinition {
	return {
		id,
		name: id,
		revision: 0,
		root: rect(`${id}-root`),
		properties: [],
		...overridesPart,
	};
}

function textProperty(index: number): CanvasComponentProperty {
	return {
		id: `p${index}`,
		name: `P${index}`,
		nodeId: "n1",
		kind: "text",
		targetKind: "text",
	};
}

function registryOf(count: number) {
	const registry: Record<string, CanvasComponentDefinition> = {};
	for (let i = 0; i < count; i += 1) {
		registry[`cmp-${i}`] = definition(`cmp-${i}`);
	}
	return registry;
}

describe("component resource caps (M1-07, D-3)", () => {
	it("definitions per document: boundary passes, over-limit rejects", () => {
		expect(() =>
			CanvasComponentRegistrySchema.parse(
				registryOf(MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT),
			),
		).not.toThrow();
		expect(() =>
			CanvasComponentRegistrySchema.parse(
				registryOf(MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT + 1),
			),
		).toThrow(/definitions/);
	});

	it("Source nodes per definition: boundary passes, over-limit rejects", () => {
		const atCap = {
			"cmp-big": definition("cmp-big", {
				root: groupWithChildren(
					"big",
					MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION - 1,
				),
			}),
		};
		expect(() => CanvasComponentRegistrySchema.parse(atCap)).not.toThrow();

		const overCap = {
			"cmp-big": definition("cmp-big", {
				root: groupWithChildren(
					"big",
					MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION,
				),
			}),
		};
		expect(() => CanvasComponentRegistrySchema.parse(overCap)).toThrow(
			/Source nodes/,
		);
	});

	it("properties per component: boundary passes, over-limit rejects", () => {
		const atCap = {
			"cmp-p": definition("cmp-p", {
				properties: Array.from(
					{ length: MAX_COMPONENT_PROPERTIES_PER_COMPONENT },
					(_, i) => textProperty(i),
				),
			}),
		};
		expect(() => CanvasComponentRegistrySchema.parse(atCap)).not.toThrow();

		const overCap = {
			"cmp-p": definition("cmp-p", {
				properties: Array.from(
					{ length: MAX_COMPONENT_PROPERTIES_PER_COMPONENT + 1 },
					(_, i) => textProperty(i),
				),
			}),
		};
		expect(() => CanvasComponentRegistrySchema.parse(overCap)).toThrow();
	});

	it("overrides per instance: boundary passes, over-limit rejects", () => {
		const overridesOf = (count: number) => {
			const map: Record<string, CanvasComponentOverride> = {};
			for (let i = 0; i < count; i += 1) {
				map[`p${i}`] = { kind: "visibility", visible: false };
			}
			return map;
		};
		const instance = (count: number) => ({
			id: "inst",
			type: "component-instance",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			componentId: "cmp",
			overrides: overridesOf(count),
		});
		expect(() =>
			CanvasComponentInstanceNodeSchema.parse(
				instance(MAX_COMPONENT_OVERRIDES_PER_INSTANCE),
			),
		).not.toThrow();
		expect(() =>
			CanvasComponentInstanceNodeSchema.parse(
				instance(MAX_COMPONENT_OVERRIDES_PER_INSTANCE + 1),
			),
		).toThrow(/overrides/);
	});

	it("plain text override characters: boundary passes, over-limit rejects", () => {
		expect(() =>
			CanvasTextOverrideValueSchema.parse({
				kind: "plain",
				text: "x".repeat(MAX_COMPONENT_TEXT_OVERRIDE_CHARS),
			}),
		).not.toThrow();
		expect(() =>
			CanvasTextOverrideValueSchema.parse({
				kind: "plain",
				text: "x".repeat(MAX_COMPONENT_TEXT_OVERRIDE_CHARS + 1),
			}),
		).toThrow();
	});

	it("rich paragraphs per override: boundary passes, over-limit rejects", () => {
		const paragraphs = (count: number) =>
			Array.from({ length: count }, () => ({ spans: [{ text: "x" }] }));
		expect(() =>
			CanvasTextOverrideValueSchema.parse({
				kind: "rich",
				paragraphs: paragraphs(MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE),
			}),
		).not.toThrow();
		expect(() =>
			CanvasTextOverrideValueSchema.parse({
				kind: "rich",
				paragraphs: paragraphs(MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE + 1),
			}),
		).toThrow();
	});

	it("rich spans per paragraph: boundary passes, over-limit rejects", () => {
		const withSpans = (count: number) => ({
			kind: "rich",
			paragraphs: [
				{ spans: Array.from({ length: count }, () => ({ text: "x" })) },
			],
		});
		expect(() =>
			CanvasTextOverrideValueSchema.parse(
				withSpans(MAX_COMPONENT_RICH_SPANS_PER_PARAGRAPH),
			),
		).not.toThrow();
		expect(() =>
			CanvasTextOverrideValueSchema.parse(
				withSpans(MAX_COMPONENT_RICH_SPANS_PER_PARAGRAPH + 1),
			),
		).toThrow(/spans/);
	});

	it("rich total characters share the plain ceiling: boundary passes, over-limit rejects", () => {
		const half = Math.floor(MAX_COMPONENT_TEXT_OVERRIDE_CHARS / 2);
		const rest = MAX_COMPONENT_TEXT_OVERRIDE_CHARS - half;
		expect(() =>
			CanvasTextOverrideValueSchema.parse({
				kind: "rich",
				paragraphs: [
					{ spans: [{ text: "x".repeat(half) }] },
					{ spans: [{ text: "x".repeat(rest) }] },
				],
			}),
		).not.toThrow();
		expect(() =>
			CanvasTextOverrideValueSchema.parse({
				kind: "rich",
				paragraphs: [
					{ spans: [{ text: "x".repeat(half) }] },
					{ spans: [{ text: "x".repeat(rest + 1) }] },
				],
			}),
		).toThrow(/characters/);
	});

	it("pins the M2-enforced caps' values and anchors", () => {
		// Depth must never approach the walker guard (a fully expanded virtual
		// tree still sits under a page subtree).
		expect(MAX_COMPONENT_NESTED_DEPTH).toBeLessThanOrEqual(MAX_TREE_DEPTH / 2);
		expect(MAX_COMPONENT_NESTED_DEPTH).toBe(16);
		// Expansion output is a document-scale node set — same ceiling.
		expect(MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION).toBe(
			MAX_DOCUMENT_NODES,
		);
	});
});
