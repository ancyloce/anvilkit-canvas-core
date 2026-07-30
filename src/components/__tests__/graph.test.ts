import { describe, expect, it } from "vitest";
import {
	createComponentInstance,
	createGroup,
	createRect,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentRegistry,
	CanvasNode,
} from "../../ir/types.js";
import { MAX_COMPONENT_NESTED_DEPTH } from "../../limits.js";
import { buildComponentGraph, collectNestedComponentIds } from "../graph.js";

/**
 * M2-02 (plan 0023, TD §7): T-GRAPH-1 direct self-reference, T-GRAPH-2
 * indirect cycle + hostile deep chain, plus the determinism the diagnostics
 * ordering depends on — identical output regardless of registry key order.
 */

function def(id: string, root: CanvasNode): CanvasComponentDefinition {
	return { id, name: id, revision: 0, root, properties: [] };
}

function defReferencing(id: string, refs: readonly string[]) {
	return def(
		id,
		createGroup({
			id: `${id}-root`,
			children: refs.map((ref, i) =>
				createComponentInstance({
					id: `${id}-inst-${i}`,
					bounds: { width: 10, height: 10 },
					componentId: ref,
				}),
			),
		}),
	);
}

describe("collectNestedComponentIds (M2-02)", () => {
	it("collects deep references, deduped and sorted", () => {
		const root = createGroup({
			id: "r",
			children: [
				createRect({ id: "r1", bounds: { width: 1, height: 1 } }),
				createGroup({
					id: "g",
					children: [
						createComponentInstance({
							id: "i1",
							bounds: { width: 1, height: 1 },
							componentId: "cmp-z",
						}),
						createComponentInstance({
							id: "i2",
							bounds: { width: 1, height: 1 },
							componentId: "cmp-a",
						}),
						createComponentInstance({
							id: "i3",
							bounds: { width: 1, height: 1 },
							componentId: "cmp-z",
						}),
					],
				}),
			],
		});
		expect(collectNestedComponentIds(root)).toEqual(["cmp-a", "cmp-z"]);
	});
});

describe("buildComponentGraph (T-GRAPH-1/2)", () => {
	it("reports a direct self-reference as a one-member cycle", () => {
		const graph = buildComponentGraph({
			"cmp-a": defReferencing("cmp-a", ["cmp-a"]),
		});
		expect(graph.cycles).toEqual([["cmp-a"]]);
		expect(graph.topologicalOrder).toEqual([]);
		expect(graph.chainDepths.size).toBe(0);
	});

	it("reports an indirect A→B→A cycle once, rotation-normalized", () => {
		const graph = buildComponentGraph({
			"cmp-b": defReferencing("cmp-b", ["cmp-a"]),
			"cmp-a": defReferencing("cmp-a", ["cmp-b"]),
		});
		expect(graph.cycles).toEqual([["cmp-a", "cmp-b"]]);
	});

	it("flags a hostile deep chain past MAX_COMPONENT_NESTED_DEPTH", () => {
		const registry: Record<string, CanvasComponentDefinition> = {};
		const chainLength = MAX_COMPONENT_NESTED_DEPTH + 2;
		for (let i = 0; i < chainLength; i += 1) {
			const id = `cmp-${String(i).padStart(2, "0")}`;
			const next =
				i + 1 < chainLength ? [`cmp-${String(i + 1).padStart(2, "0")}`] : [];
			registry[id] = defReferencing(id, next);
		}
		const graph = buildComponentGraph(registry as CanvasComponentRegistry);
		expect(graph.cycles).toEqual([]);
		expect(graph.chainDepths.get("cmp-00")).toBe(chainLength);
		expect(graph.depthExceeded).toEqual(["cmp-00", "cmp-01"]);
	});

	it("keeps missing references in dependencies but out of the order", () => {
		const graph = buildComponentGraph({
			"cmp-a": defReferencing("cmp-a", ["cmp-ghost"]),
		});
		expect(graph.dependencies.get("cmp-a")).toEqual(["cmp-ghost"]);
		expect(graph.topologicalOrder).toEqual(["cmp-a"]);
		expect(graph.chainDepths.get("cmp-a")).toBe(1);
	});

	it("orders dependency-first with sorted ties, independent of key order", () => {
		const forward = {
			"cmp-a": defReferencing("cmp-a", ["cmp-b", "cmp-c"]),
			"cmp-b": defReferencing("cmp-b", ["cmp-c"]),
			"cmp-c": defReferencing("cmp-c", []),
			"cmp-d": defReferencing("cmp-d", []),
		};
		const reversed = Object.fromEntries(Object.entries(forward).reverse());
		const a = buildComponentGraph(forward);
		const b = buildComponentGraph(reversed as CanvasComponentRegistry);
		expect(a.topologicalOrder).toEqual(["cmp-c", "cmp-b", "cmp-a", "cmp-d"]);
		expect(b.topologicalOrder).toEqual(a.topologicalOrder);
		expect([...b.chainDepths.entries()]).toEqual([...a.chainDepths.entries()]);
		expect(a.chainDepths.get("cmp-a")).toBe(3);
	});
});
