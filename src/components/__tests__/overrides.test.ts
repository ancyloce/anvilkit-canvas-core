import { describe, expect, it } from "vitest";
import {
	createFrame,
	createGroup,
	createRect,
	createRichText,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasFrameNode,
	CanvasRectNode,
	CanvasRichTextNode,
	CanvasTextNode,
} from "../../ir/types.js";
import { applyComponentOverrides } from "../overrides.js";

/**
 * T-OVR-1 (plan 0023 M2-04): every override type against a valid and an
 * invalid target, the §10.3 orphan lifecycle, INV-4 purity, and INV-6
 * retention. Diagnostic order is part of the contract (sorted Property ID).
 */

function cardDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-card",
		name: "Card",
		revision: 1,
		root: createGroup({
			id: "card-root",
			children: [
				createText({
					id: "card-title",
					text: "Default",
					fontFamily: "Inter",
					fontSize: 14,
					fill: "#111111",
					bounds: { width: 100, height: 20 },
				}),
				createRichText({
					id: "card-body",
					width: 100,
					paragraphs: [{ spans: [{ text: "default body" }] }],
					bounds: { width: 100, height: 40 },
				}),
				createRect({
					id: "card-media",
					fill: "#eeeeee",
					bounds: { width: 100, height: 40 },
				}),
				createFrame({
					id: "card-slot",
					bounds: { width: 40, height: 40 },
					placeholder: { kind: "image", assetId: "asset-default" },
				}),
			],
		}),
		properties: [
			{
				id: "p-title",
				name: "Title",
				nodeId: "card-title",
				kind: "text",
				targetKind: "text",
			},
			{
				id: "p-body",
				name: "Body",
				nodeId: "card-body",
				kind: "text",
				targetKind: "rich-text",
			},
			{
				id: "p-media",
				name: "Media",
				nodeId: "card-slot",
				kind: "image",
				targetKind: "frame",
			},
			{
				id: "p-tint",
				name: "Tint",
				nodeId: "card-media",
				kind: "color",
				targetField: "fill",
			},
			{
				id: "p-show",
				name: "Show media",
				nodeId: "card-media",
				kind: "visibility",
			},
			{
				id: "p-gone",
				name: "Dangling",
				nodeId: "no-such-node",
				kind: "visibility",
			},
		],
	};
}

describe("applyComponentOverrides — valid targets (T-OVR-1)", () => {
	it("applies every override type and composes multiple patches on one node", () => {
		const definition = cardDefinition();
		const before = JSON.parse(JSON.stringify(definition));
		const overrides: CanvasComponentOverrideMap = {
			"p-title": { kind: "text", value: { kind: "plain", text: "Hello" } },
			"p-body": {
				kind: "text",
				value: { kind: "rich", paragraphs: [{ spans: [{ text: "new" }] }] },
			},
			"p-media": { kind: "image", assetId: "asset-new" },
			"p-tint": { kind: "color", value: "#ff0000" },
			"p-show": { kind: "visibility", visible: false },
		};

		const { patches, issues } = applyComponentOverrides(definition, overrides, {
			instanceId: "inst-1",
		});

		expect(issues).toEqual([]);
		expect((patches.get("card-title") as CanvasTextNode).text).toBe("Hello");
		expect((patches.get("card-body") as CanvasRichTextNode).paragraphs).toEqual(
			[{ spans: [{ text: "new" }] }],
		);
		expect(
			(patches.get("card-slot") as CanvasFrameNode).placeholder?.assetId,
		).toBe("asset-new");
		// color + visibility COMPOSE on card-media.
		const media = patches.get("card-media") as CanvasRectNode;
		expect(media.fill).toBe("#ff0000");
		expect(media.visible).toBe(false);

		// INV-4: inputs untouched.
		expect(JSON.parse(JSON.stringify(definition))).toEqual(before);
	});
});

describe("applyComponentOverrides — invalid targets and orphans", () => {
	it("emits sorted diagnostics and applies nothing for each failure mode", () => {
		const definition = cardDefinition();
		const overrides: CanvasComponentOverrideMap = {
			// orphan: no such property
			"p-ghost": { kind: "visibility", visible: true },
			// kind mismatch: property is text, override is color
			"p-title": { kind: "color", value: "#00ff00" },
			// plain value on a rich-text target: §10.1 pair violation
			"p-body": { kind: "text", value: { kind: "plain", text: "nope" } },
			// property whose target node no longer exists
			"p-gone": { kind: "visibility", visible: false },
		};

		const { patches, issues } = applyComponentOverrides(definition, overrides, {
			instanceId: "inst-1",
		});

		expect(patches.size).toBe(0);
		expect(issues.map((i) => [i.code, i.propertyId])).toEqual([
			["component-property-type-invalid", "p-body"],
			["component-override-orphan", "p-ghost"],
			["component-property-target-missing", "p-gone"],
			["component-override-type-invalid", "p-title"],
		]);
		for (const issue of issues) {
			expect(issue.severity).toBe("warning");
			expect(issue.componentId).toBe("cmp-card");
			expect(issue.instanceId).toBe("inst-1");
		}
	});

	it("rejects an image override on a frame without a placeholder", () => {
		const definition = cardDefinition();
		const bare = createFrame({ id: "bare", bounds: { width: 5, height: 5 } });
		(definition.root as { children: unknown[] }).children.push(bare);
		definition.properties = [
			...definition.properties,
			{
				id: "p-bare",
				name: "Bare",
				nodeId: "bare",
				kind: "image",
				targetKind: "frame",
			},
		];
		const { patches, issues } = applyComponentOverrides(definition, {
			"p-bare": { kind: "image", assetId: "asset-x" },
		});
		expect(patches.size).toBe(0);
		expect(issues[0]?.code).toBe("component-property-type-invalid");
		expect(issues[0]?.message).toContain("no placeholder");
	});

	it("§10.3: the same orphan applies again once its property is restored compatibly", () => {
		const definition = cardDefinition();
		const overrides: CanvasComponentOverrideMap = {
			"p-late": { kind: "visibility", visible: false },
		};
		const orphaned = applyComponentOverrides(definition, overrides);
		expect(orphaned.issues[0]?.code).toBe("component-override-orphan");

		const restored: CanvasComponentDefinition = {
			...definition,
			properties: [
				...definition.properties,
				{
					id: "p-late",
					name: "Late",
					nodeId: "card-media",
					kind: "visibility",
				},
			],
		};
		const applied = applyComponentOverrides(restored, overrides);
		expect(applied.issues).toEqual([]);
		expect((applied.patches.get("card-media") as CanvasRectNode).visible).toBe(
			false,
		);
	});
});
