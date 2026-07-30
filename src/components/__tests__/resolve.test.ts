import { describe, expect, it } from "vitest";
import {
	createComponentInstance,
	createFrame,
	createGroup,
	createRect,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasComponentRegistry,
	CanvasGroupNode,
	CanvasNode,
	CanvasRectNode,
	CanvasTextNode,
} from "../../ir/types.js";
import { createComponentResolutionCache } from "../cache.js";
import { buildComponentGraph } from "../graph.js";
import { decodeResolvedNodeId, encodeResolvedNodeId } from "../identity.js";
import { resolveComponentInstance } from "../resolve.js";

/**
 * M2-05/M2-07 (plan 0023): T-RES-1 nested resolution determinism, and
 * T-ERR-1/2/3 — missing Source, read-time cycle, and expansion-limit
 * degradation. Every degradation is a SELECTABLE placeholder (the instance
 * node itself, overrides retained), never a throw.
 */

function buttonDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-button",
		name: "Button",
		revision: 2,
		root: createFrame({
			id: "btn-root",
			bounds: { width: 40, height: 20 },
			children: [
				createText({
					id: "btn-label",
					text: "Click",
					fontFamily: "Inter",
					fontSize: 12,
					fill: "#ffffff",
					bounds: { width: 40, height: 20 },
				}),
			],
		}),
		properties: [],
	};
}

function cardDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-card",
		name: "Card",
		revision: 5,
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
				createComponentInstance({
					id: "card-nested",
					transform: { x: 0, y: 30 },
					bounds: { width: 40, height: 20 },
					componentId: "cmp-button",
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
		],
	};
}

function registry(): CanvasComponentRegistry {
	return { "cmp-card": cardDefinition(), "cmp-button": buttonDefinition() };
}

function cardInstance(): CanvasComponentInstanceNode {
	return createComponentInstance({
		id: "inst-1",
		name: "Hero card",
		transform: { x: 100, y: 200 },
		bounds: { width: 120, height: 90 },
		componentId: "cmp-card",
		overrides: {
			"p-title": { kind: "text", value: { kind: "plain", text: "Hello!" } },
		},
	});
}

describe("resolveComponentInstance (T-RES-1)", () => {
	it("expands nested components deterministically with correct provenance", () => {
		const reg = registry();
		const instance = cardInstance();
		const first = resolveComponentInstance(reg, instance);
		const second = resolveComponentInstance(reg, instance);

		expect(first.placeholder).toBe(false);
		expect(first.issues).toEqual([]);
		// Determinism, including diagnostic and origin iteration order.
		expect(JSON.parse(JSON.stringify(second))).toEqual(
			JSON.parse(JSON.stringify(first)),
		);

		// Root: persistent id + instance placement, Source content composed in.
		const root = first.root as CanvasGroupNode;
		expect(root.id).toBe("inst-1");
		expect(root.type).toBe("group");
		expect(root.transform.x).toBe(100);
		expect(root.bounds).toEqual({ width: 120, height: 90 });
		expect(root.name).toBe("Hero card");

		// Depth-1 child: override applied, id is the encoded [inst, defNode] path.
		const titleId = encodeResolvedNodeId({
			segments: ["inst-1", "card-title"],
		}) as string;
		const title = root.children.find((n) => n.id === titleId) as CanvasTextNode;
		expect(title.text).toBe("Hello!");
		expect(first.origins.get(titleId)).toEqual({
			instanceId: "inst-1",
			componentId: "cmp-card",
			definitionNodeId: "card-title",
			depth: 1,
		});

		// Nested boundary: the def-tree instance node became the button subtree.
		const nestedId = encodeResolvedNodeId({
			segments: ["inst-1", "card-nested"],
		}) as string;
		const nested = root.children.find(
			(n) => n.id === nestedId,
		) as CanvasNode & {
			children: CanvasNode[];
		};
		expect(nested.type).toBe("frame");
		const nestedLabel = nested.children[0] as CanvasTextNode;
		expect(decodeResolvedNodeId(nestedLabel.id as never).segments).toEqual([
			"inst-1",
			"card-nested",
			"btn-label",
		]);
		expect(first.origins.get(nestedLabel.id)?.depth).toBe(2);
		expect(first.origins.get(nestedLabel.id)?.componentId).toBe("cmp-button");

		expect(first.expandedNodeCount).toBe(4);
		expect(first.cacheKey).toContain("cmp-card");
	});

	it("serves an identical instance from the cache and recomputes after invalidation", () => {
		const reg = registry();
		const cache = createComponentResolutionCache();
		const graph = buildComponentGraph(reg);
		const a = resolveComponentInstance(reg, cardInstance(), { cache, graph });
		const b = resolveComponentInstance(reg, cardInstance(), { cache, graph });
		expect(b).toBe(a);

		cache.invalidateComponent("cmp-button", graph);
		const c = resolveComponentInstance(reg, cardInstance(), { cache, graph });
		expect(c).not.toBe(a);
		expect(JSON.parse(JSON.stringify(c))).toEqual(
			JSON.parse(JSON.stringify(a)),
		);
	});
});

describe("degradation (T-ERR-1/2/3)", () => {
	it("T-ERR-1: a missing Source yields the instance itself with overrides retained", () => {
		const instance = cardInstance();
		const result = resolveComponentInstance({}, instance);
		expect(result.placeholder).toBe(true);
		expect(result.root).toBe(instance);
		expect((result.root as CanvasComponentInstanceNode).overrides).toEqual(
			instance.overrides,
		);
		expect(result.cacheKey).toBe("unresolvable");
		expect(result.issues.map((i) => i.code)).toEqual([
			"component-source-missing",
		]);
		expect(result.issues[0]?.severity).toBe("warning");
	});

	it("T-ERR-2: a read-time cycle degrades at the recursion boundary only", () => {
		const a: CanvasComponentDefinition = {
			id: "cmp-a",
			name: "A",
			revision: 0,
			root: createGroup({
				id: "a-root",
				children: [
					createRect({ id: "a-rect", bounds: { width: 5, height: 5 } }),
					createComponentInstance({
						id: "a-to-b",
						bounds: { width: 5, height: 5 },
						componentId: "cmp-b",
					}),
				],
			}),
			properties: [],
		};
		const b: CanvasComponentDefinition = {
			id: "cmp-b",
			name: "B",
			revision: 0,
			root: createGroup({
				id: "b-root",
				children: [
					createComponentInstance({
						id: "b-to-a",
						bounds: { width: 5, height: 5 },
						componentId: "cmp-a",
					}),
				],
			}),
			properties: [],
		};
		const result = resolveComponentInstance(
			{ "cmp-a": a, "cmp-b": b },
			createComponentInstance({
				id: "inst-a",
				bounds: { width: 10, height: 10 },
				componentId: "cmp-a",
			}),
		);

		// The outer expansion is NOT a placeholder…
		expect(result.placeholder).toBe(false);
		const root = result.root as CanvasGroupNode;
		expect(root.id).toBe("inst-a");
		// …only the boundary node degrades: b's nested a stays an instance view.
		const boundaryPath = ["inst-a", "a-to-b", "b-to-a"];
		const boundaryId = encodeResolvedNodeId({
			segments: boundaryPath,
		}) as string;
		const bSubtree = root.children.find(
			(n) =>
				n.id ===
				(encodeResolvedNodeId({ segments: ["inst-a", "a-to-b"] }) as string),
		) as CanvasGroupNode;
		const boundary = bSubtree.children.find((n) => n.id === boundaryId);
		expect(boundary?.type).toBe("component-instance");
		expect(result.issues.some((i) => i.code === "component-cycle")).toBe(true);
		expect(
			result.issues.find((i) => i.code === "component-cycle")?.severity,
		).toBe("error");
	});

	it("T-ERR-3: a blown node budget emits one limit diagnostic and bounded output", () => {
		const result = resolveComponentInstance(registry(), cardInstance(), {
			maxExpandedNodes: 2,
		});
		expect(
			result.issues.filter((i) => i.code === "component-expanded-node-limit"),
		).toHaveLength(1);
		expect(result.expandedNodeCount).toBeLessThanOrEqual(2);
	});

	it("depth cap degrades the nested boundary, not the outer expansion", () => {
		const result = resolveComponentInstance(registry(), cardInstance(), {
			maxDepth: 1,
		});
		expect(result.placeholder).toBe(false);
		expect(
			result.issues.some((i) => i.code === "component-depth-exceeded"),
		).toBe(true);
		const nestedId = encodeResolvedNodeId({
			segments: ["inst-1", "card-nested"],
		}) as string;
		const nested = (result.root as CanvasGroupNode).children.find(
			(n) => n.id === nestedId,
		);
		expect(nested?.type).toBe("component-instance");
	});
});
