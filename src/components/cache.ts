/**
 * @file Resolver cache (plan 0023 M2-08, TD §12).
 *
 * Four layers (§12.2): definition structural, base virtual, instance, page
 * resolved. Session-scoped and DISCARDABLE — nothing here is ever persisted,
 * and dropping the whole cache only costs re-resolution (INV-4 stays trivially
 * true: entries hold runtime views, never document mutations).
 *
 * Only the state factory, the invalidation entry points, and a counts-only
 * `stats()` ship through the public barrel; keys, layer maps, and hash
 * helpers are internal to the `components/` domain (resolve.ts imports them
 * directly). Hashes reuse the shared `fingerprint64` so figures stay
 * comparable with `layout/`'s cache keys.
 */

import { fingerprint64 } from "../hash.js";
import type {
	CanvasComponentOverride,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
	CanvasComponentRegistry,
	CanvasNode,
} from "../ir/types.js";
import type { CanvasComponentGraph } from "./graph.js";
import { collectNestedComponentIds } from "./graph.js";
import { indexDefinitionNodes } from "./overrides.js";

/** Definition-structural entry (§12.2 layer 1): tree index, property map, dependency list. */
export interface ComponentDefinitionStructure {
	readonly revision: number;
	readonly nodesById: ReadonlyMap<string, CanvasNode>;
	readonly propertiesById: ReadonlyMap<string, CanvasComponentProperty>;
	readonly nestedComponentIds: readonly string[];
	readonly nodeCount: number;
}

interface CacheLayers {
	readonly definition: Map<string, ComponentDefinitionStructure>;
	readonly base: Map<string, unknown>;
	readonly instance: Map<string, unknown>;
	readonly page: Map<
		string,
		{ componentIds: ReadonlySet<string>; value: unknown }
	>;
}

export interface CanvasComponentResolutionCache {
	/**
	 * Drop every entry for `componentId` AND its transitive dependents —
	 * §11.3 step 5. Entries for unrelated components survive (T-PERF-1).
	 */
	invalidateComponent(componentId: string, graph: CanvasComponentGraph): void;
	invalidateAll(): void;
	/** Counts only — entries never leak through the public surface. */
	stats(): {
		definition: number;
		base: number;
		instance: number;
		page: number;
	};
}

/** The concrete state, internal to the domain. */
export interface ComponentCacheState extends CanvasComponentResolutionCache {
	readonly layers: CacheLayers;
}

/**
 * Transitive DEPENDENTS of `componentId` (everything whose expansion embeds
 * it), including itself — the §11.3 invalidation set.
 */
export function collectDependents(
	componentId: string,
	graph: CanvasComponentGraph,
): ReadonlySet<string> {
	const reverse = new Map<string, string[]>();
	for (const [from, deps] of graph.dependencies) {
		for (const dep of deps) {
			const list = reverse.get(dep);
			if (list) list.push(from);
			else reverse.set(dep, [from]);
		}
	}
	const dependents = new Set<string>([componentId]);
	const queue = [componentId];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const parent of reverse.get(current) ?? []) {
			if (!dependents.has(parent)) {
				dependents.add(parent);
				queue.push(parent);
			}
		}
	}
	return dependents;
}

/** Downcast to the domain-internal state. NEVER exported through the barrel. */
export function internalCacheState(
	cache: CanvasComponentResolutionCache,
): ComponentCacheState {
	return cache as ComponentCacheState;
}

export function createComponentResolutionCache(): CanvasComponentResolutionCache {
	const layers: CacheLayers = {
		definition: new Map(),
		base: new Map(),
		instance: new Map(),
		page: new Map(),
	};
	const dropByComponent = (ids: ReadonlySet<string>): void => {
		for (const key of [...layers.definition.keys()]) {
			if (ids.has(key)) layers.definition.delete(key);
		}
		// Base/instance keys embed the component id as their first `:`-free
		// length-prefixed field — see `composeCacheKey` — so membership is a
		// prefix check against each id's encoded head.
		for (const layer of [layers.base, layers.instance]) {
			for (const key of [...layer.keys()]) {
				if (ids.has(componentIdOfKey(key))) layer.delete(key);
			}
		}
		for (const [key, entry] of [...layers.page.entries()]) {
			for (const id of ids) {
				if (entry.componentIds.has(id)) {
					layers.page.delete(key);
					break;
				}
			}
		}
	};
	const state: ComponentCacheState = {
		layers,
		invalidateComponent(componentId, graph) {
			dropByComponent(collectDependents(componentId, graph));
		},
		invalidateAll() {
			layers.definition.clear();
			layers.base.clear();
			layers.instance.clear();
			layers.page.clear();
		},
		stats() {
			return {
				definition: layers.definition.size,
				base: layers.base.size,
				instance: layers.instance.size,
				page: layers.page.size,
			};
		},
	};
	return state;
}

/**
 * Layer-1 lookup: the memoized structural index of one definition, rebuilt
 * only when its `revision` moved.
 */
export function getDefinitionStructure(
	cache: ComponentCacheState,
	registry: CanvasComponentRegistry,
	componentId: string,
): ComponentDefinitionStructure | undefined {
	const definition = registry[componentId];
	if (!definition) return undefined;
	const cached = cache.layers.definition.get(componentId);
	if (cached && cached.revision === definition.revision) return cached;
	const nodesById = indexDefinitionNodes(definition.root);
	const propertiesById = new Map(definition.properties.map((p) => [p.id, p]));
	const structure: ComponentDefinitionStructure = {
		revision: definition.revision,
		nodesById,
		propertiesById,
		nestedComponentIds: collectNestedComponentIds(definition.root),
		nodeCount: nodesById.size,
	};
	cache.layers.definition.set(componentId, structure);
	return structure;
}

/** Canonical (sorted-key) hash of a full override map. */
export function computeOverrideHash(
	overrides: CanvasComponentOverrideMap | undefined,
): string {
	if (!overrides) return "none";
	const keys = Object.keys(overrides).sort();
	if (keys.length === 0) return "none";
	return fingerprint64(JSON.stringify(keys.map((k) => [k, overrides[k]])));
}

/**
 * Hash of the GEOMETRY-AFFECTING override subset: text and image change a
 * node's intrinsic size, visibility changes layout participation — color is
 * paint-only. §12.2's reuse rule keys base-virtual reuse on this: a base
 * layout is shared ONLY between instances whose geometry-affecting subset is
 * identical.
 */
export function computeGeometryOverrideHash(
	overrides: CanvasComponentOverrideMap | undefined,
): string {
	if (!overrides) return "none";
	const geometryKinds = new Set<CanvasComponentOverride["kind"]>([
		"text",
		"image",
		"visibility",
	]);
	const entries = Object.keys(overrides)
		.sort()
		.map((k) => [k, overrides[k]] as const)
		.filter(([, o]) => o && geometryKinds.has(o.kind));
	if (entries.length === 0) return "none";
	return fingerprint64(JSON.stringify(entries));
}

/**
 * Revision hash over a component's TRANSITIVE dependency cone (sorted
 * `id@revision` pairs) — the §12.1 `nestedDependencyRevisionHash` that makes
 * a nested Source edit invalidate every containing key.
 */
export function computeDependencyRevisionHash(
	componentId: string,
	registry: CanvasComponentRegistry,
	graph: CanvasComponentGraph,
): string {
	const cone: string[] = [];
	const seen = new Set<string>();
	const queue = [...(graph.dependencies.get(componentId) ?? [])];
	while (queue.length > 0) {
		const id = queue.shift() as string;
		if (seen.has(id)) continue;
		seen.add(id);
		const definition = registry[id];
		cone.push(`${id}@${definition ? definition.revision : "missing"}`);
		queue.push(...(graph.dependencies.get(id) ?? []));
	}
	if (cone.length === 0) return "none";
	return fingerprint64(cone.sort().join("|"));
}

export interface ComponentCacheKeyParts {
	readonly componentId: string;
	readonly sourceRevision: number;
	readonly overrideHash: string;
	readonly nestedDependencyRevisionHash: string;
	/** `CanvasResolvedDocument.engineVersion` (PRD 0014). */
	readonly layoutEngineVersion: number;
	readonly measurementManifestHash?: string;
	readonly assetIntrinsicManifestHash?: string;
	/**
	 * The instance whose expansion this entry holds (plan 0023 M6-03).
	 *
	 * REQUIRED for correctness, not an optimisation knob. A cached
	 * `CanvasResolvedComponentInstance` is instance-SPECIFIC: its `root` carries
	 * the instance's own id and every descendant carries a virtual id whose path
	 * starts with that id. Keying only on (component, revision, overrides, …)
	 * therefore made two identical instances share ONE entry, so the second
	 * instance was handed the FIRST one's subtree — same ids top to bottom —
	 * and the resolved-records map (keyed by id) silently collapsed them into a
	 * single node. A page of 100 identical instances resolved to 3 records and
	 * exported one component.
	 *
	 * Including it costs nothing that was ever valid: reuse across DIFFERENT
	 * instances could never have been correct, while the reuse that matters —
	 * the same instance re-resolved on every pointer move — is preserved exactly.
	 */
	readonly instanceId: string;
}

/** The §12.1 composite key. Length-prefixed head so `componentIdOfKey` never misparses an id containing the separator. */
export function composeCacheKey(parts: ComponentCacheKeyParts): string {
	return [
		`${parts.componentId.length}:${parts.componentId}`,
		parts.sourceRevision,
		parts.overrideHash,
		parts.nestedDependencyRevisionHash,
		parts.layoutEngineVersion,
		parts.measurementManifestHash ?? "none",
		parts.assetIntrinsicManifestHash ?? "none",
		// Length-prefixed like the component id: an instance id is an arbitrary
		// document string and must not be able to collide with the separator.
		`${parts.instanceId.length}:${parts.instanceId}`,
	].join("|");
}

function componentIdOfKey(key: string): string {
	const colon = key.indexOf(":");
	if (colon <= 0) return "";
	const length = Number(key.slice(0, colon));
	if (!Number.isInteger(length) || length < 0) return "";
	return key.slice(colon + 1, colon + 1 + length);
}
