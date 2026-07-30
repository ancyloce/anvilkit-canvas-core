import { describe, expect, it } from "vitest";
import {
	createComponentInstance,
	createGroup,
	createRect,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasComponentRegistry,
	CanvasNode,
} from "../../ir/types.js";
import {
	collectDependents,
	composeCacheKey,
	computeDependencyRevisionHash,
	computeGeometryOverrideHash,
	computeOverrideHash,
	createComponentResolutionCache,
	getDefinitionStructure,
	internalCacheState,
} from "../cache.js";
import { buildComponentGraph } from "../graph.js";

/**
 * M2-08 / T-PERF-1 core (plan 0023, TD §12): the structural layer memoizes
 * on revision, hashes are canonical (key-order independent), the base-reuse
 * rule separates geometry-affecting overrides from paint-only ones, and
 * invalidation drops exactly a component's transitive dependents.
 */

function def(
	id: string,
	root: CanvasNode,
	revision = 0,
): CanvasComponentDefinition {
	return { id, name: id, revision, root, properties: [] };
}

function defReferencing(id: string, refs: readonly string[], revision = 0) {
	return def(
		id,
		createGroup({
			id: `${id}-root`,
			children: refs.map((ref, i) =>
				createComponentInstance({
					id: `${id}-i${i}`,
					bounds: { width: 5, height: 5 },
					componentId: ref,
				}),
			),
		}),
		revision,
	);
}

/** a → b → c, plus standalone d. */
function chainRegistry(): CanvasComponentRegistry {
	return {
		"cmp-a": defReferencing("cmp-a", ["cmp-b"], 1),
		"cmp-b": defReferencing("cmp-b", ["cmp-c"], 2),
		"cmp-c": def(
			"cmp-c",
			createRect({ id: "c-root", bounds: { width: 4, height: 4 } }),
			3,
		),
		"cmp-d": def(
			"cmp-d",
			createRect({ id: "d-root", bounds: { width: 4, height: 4 } }),
			4,
		),
	};
}

describe("definition structural layer", () => {
	it("memoizes per revision and rebuilds only when it moves", () => {
		const cache = internalCacheState(createComponentResolutionCache());
		const registry = chainRegistry();
		const first = getDefinitionStructure(cache, registry, "cmp-a");
		const second = getDefinitionStructure(cache, registry, "cmp-a");
		expect(second).toBe(first);
		expect(first?.nestedComponentIds).toEqual(["cmp-b"]);
		expect(first?.nodeCount).toBe(2);

		const bumped: CanvasComponentRegistry = {
			...registry,
			"cmp-a": {
				...(registry["cmp-a"] as CanvasComponentDefinition),
				revision: 9,
			},
		};
		const third = getDefinitionStructure(cache, bumped, "cmp-a");
		expect(third).not.toBe(first);
		expect(third?.revision).toBe(9);
		expect(
			getDefinitionStructure(cache, registry, "cmp-ghost"),
		).toBeUndefined();
	});
});

describe("hashes and keys", () => {
	it("override hash is canonical across key order and none when empty", () => {
		const a: CanvasComponentOverrideMap = {
			p1: { kind: "visibility", visible: false },
			p2: { kind: "color", value: "#ff0000" },
		};
		const b: CanvasComponentOverrideMap = {
			p2: { kind: "color", value: "#ff0000" },
			p1: { kind: "visibility", visible: false },
		};
		expect(computeOverrideHash(a)).toBe(computeOverrideHash(b));
		expect(computeOverrideHash(undefined)).toBe("none");
		expect(computeOverrideHash({})).toBe("none");
	});

	it("geometry hash ignores paint-only overrides and tracks size-affecting ones", () => {
		const paintOnly: CanvasComponentOverrideMap = {
			p1: { kind: "color", value: "#ff0000" },
		};
		expect(computeGeometryOverrideHash(paintOnly)).toBe("none");

		const text: CanvasComponentOverrideMap = {
			p1: { kind: "color", value: "#ff0000" },
			p2: { kind: "text", value: { kind: "plain", text: "longer" } },
		};
		const textOtherColor: CanvasComponentOverrideMap = {
			p1: { kind: "color", value: "#00ff00" },
			p2: { kind: "text", value: { kind: "plain", text: "longer" } },
		};
		// Same geometry subset — base reuse allowed across color changes…
		expect(computeGeometryOverrideHash(text)).toBe(
			computeGeometryOverrideHash(textOtherColor),
		);
		// …but never across differing text (intrinsic size) or visibility.
		const otherText: CanvasComponentOverrideMap = {
			p2: { kind: "text", value: { kind: "plain", text: "different" } },
		};
		expect(computeGeometryOverrideHash(text)).not.toBe(
			computeGeometryOverrideHash(otherText),
		);
		const hidden: CanvasComponentOverrideMap = {
			p3: { kind: "visibility", visible: false },
		};
		expect(computeGeometryOverrideHash(hidden)).not.toBe("none");
	});

	it("dependency revision hash sees TRANSITIVE nested revisions", () => {
		const registry = chainRegistry();
		const graph = buildComponentGraph(registry);
		const before = computeDependencyRevisionHash("cmp-a", registry, graph);
		// Bump the grandchild — cmp-a's cone hash must move.
		const bumped: CanvasComponentRegistry = {
			...registry,
			"cmp-c": {
				...(registry["cmp-c"] as CanvasComponentDefinition),
				revision: 30,
			},
		};
		const after = computeDependencyRevisionHash("cmp-a", bumped, graph);
		expect(after).not.toBe(before);
		// A leaf has no cone.
		expect(computeDependencyRevisionHash("cmp-d", registry, graph)).toBe(
			"none",
		);
	});

	it("composite key embeds every §12.1 part and survives hostile ids", () => {
		const key = composeCacheKey({
			componentId: "cmp|weird:id",
			sourceRevision: 3,
			overrideHash: "abc",
			nestedDependencyRevisionHash: "def",
			layoutEngineVersion: 1,
		});
		expect(key).toContain("cmp|weird:id");
		expect(key).toContain("|3|abc|def|1|none|none");
	});
});

describe("invalidation (T-PERF-1 core)", () => {
	it("drops a component and its transitive dependents, keeps the rest", () => {
		const registry = chainRegistry();
		const graph = buildComponentGraph(registry);
		expect([...collectDependents("cmp-c", graph)].sort()).toEqual([
			"cmp-a",
			"cmp-b",
			"cmp-c",
		]);

		const cache = internalCacheState(createComponentResolutionCache());
		for (const id of Object.keys(registry)) {
			getDefinitionStructure(cache, registry, id);
		}
		cache.layers.base.set(
			composeCacheKey({
				componentId: "cmp-a",
				sourceRevision: 1,
				overrideHash: "none",
				nestedDependencyRevisionHash: "x",
				layoutEngineVersion: 1,
			}),
			{},
		);
		cache.layers.page.set("page-1", {
			componentIds: new Set(["cmp-b"]),
			value: {},
		});
		cache.layers.page.set("page-2", {
			componentIds: new Set(["cmp-d"]),
			value: {},
		});

		cache.invalidateComponent("cmp-c", graph);

		expect(cache.stats()).toEqual({
			definition: 1, // only cmp-d survives
			base: 0, // cmp-a entry dropped (dependent of c)
			instance: 0,
			page: 1, // page-2 (cmp-d) survives, page-1 (cmp-b) dropped
		});

		cache.invalidateAll();
		expect(cache.stats()).toEqual({
			definition: 0,
			base: 0,
			instance: 0,
			page: 0,
		});
	});
});
