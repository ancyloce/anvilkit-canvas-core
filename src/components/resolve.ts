/**
 * @file Component instance expansion (plan 0023 M2-05/M2-07, TD §9).
 *
 * The PURE half of resolution: registry + instance node → an expanded
 * virtual subtree of runtime node views, provenance for every virtual node,
 * diagnostics, and the §12.1 cache key. No layout here — `layout/`'s
 * composed `resolveCanvasDocument` (rank 4) splices these subtrees into the
 * document and runs the Auto Layout solver AFTER expansion, never before
 * (frozen resolution order).
 *
 * Degradation is never a throw (NFR-002): a missing Source, a cycle met at
 * read time, exhausted depth, or a blown node budget each yield a SELECTABLE
 * placeholder — the persistent instance node itself, overrides and
 * componentId retained verbatim as the recovery metadata — plus the matching
 * diagnostic. No path throws into a render.
 */

import type {
	CanvasComponentInstanceNode,
	CanvasComponentRegistry,
	CanvasNode,
} from "../ir/types.js";
import { isContainerNode } from "../ir/walkers.js";
import {
	MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
	MAX_COMPONENT_NESTED_DEPTH,
} from "../limits.js";
import {
	type CanvasComponentResolutionCache,
	composeCacheKey,
	computeDependencyRevisionHash,
	computeOverrideHash,
	getDefinitionStructure,
	internalCacheState,
} from "./cache.js";
import { buildComponentGraph, type CanvasComponentGraph } from "./graph.js";
import { encodeResolvedNodeId } from "./identity.js";
import { applyComponentOverrides } from "./overrides.js";
import type {
	CanvasComponentIssue,
	CanvasResolvedComponentOrigin,
} from "./types.js";

export interface CanvasComponentExpansionOptions {
	/** Session cache; omit for a cold, cache-free expansion. */
	readonly cache?: CanvasComponentResolutionCache;
	/** Prebuilt dependency graph; derived from the registry when absent. */
	readonly graph?: CanvasComponentGraph;
	/** Shared budget across one resolution pass. Defaults to the D-3 cap. */
	readonly maxExpandedNodes?: number;
	readonly maxDepth?: number;
	/** `CanvasResolvedDocument.engineVersion` (PRD 0014). */
	readonly layoutEngineVersion?: number;
	readonly measurementManifestHash?: string;
	readonly assetIntrinsicManifestHash?: string;
}

export interface CanvasResolvedComponentInstance {
	/**
	 * The runtime subtree replacing the instance node. Its root keeps the
	 * PERSISTENT instance id (selection stays stable); every descendant
	 * carries a codec-encoded virtual id. On degradation this is the
	 * original instance node itself — the selectable placeholder.
	 */
	readonly root: CanvasNode;
	/** Expanded-tree node id → provenance, including the root. */
	readonly origins: ReadonlyMap<string, CanvasResolvedComponentOrigin>;
	readonly issues: readonly CanvasComponentIssue[];
	/** §12.1 composite key, `"unresolvable"` for a missing Source. */
	readonly cacheKey: string;
	readonly expandedNodeCount: number;
	readonly placeholder: boolean;
}

interface ExpansionBudget {
	remaining: number;
	exhausted: boolean;
}

interface ExpansionContext {
	readonly registry: CanvasComponentRegistry;
	readonly graph: CanvasComponentGraph;
	readonly maxDepth: number;
	readonly budget: ExpansionBudget;
	/** componentIds currently being expanded — the read-time cycle guard. */
	readonly stack: string[];
	readonly issues: CanvasComponentIssue[];
	readonly origins: Map<string, CanvasResolvedComponentOrigin>;
}

function pushIssue(
	ctx: Pick<ExpansionContext, "issues">,
	issue: CanvasComponentIssue,
): void {
	ctx.issues.push(issue);
}

/**
 * Expand one instance node inside an ongoing pass. Returns the replacement
 * subtree root, or the instance itself when this boundary degrades.
 */
function expandInstance(
	ctx: ExpansionContext,
	instance: CanvasComponentInstanceNode,
	pathPrefix: readonly string[],
	depth: number,
	instanceRecordId: string,
): CanvasNode {
	const componentId = instance.componentId;
	const definition = ctx.registry[componentId];
	if (!definition) {
		pushIssue(ctx, {
			code: "component-source-missing",
			severity: "warning",
			componentId,
			instanceId: instanceRecordId,
			message: `Component "${componentId}" is not in this document's Registry; instance "${instanceRecordId}" renders as a selectable placeholder with its overrides retained.`,
		});
		return instance;
	}
	if (ctx.stack.includes(componentId)) {
		pushIssue(ctx, {
			code: "component-cycle",
			severity: "error",
			componentId,
			instanceId: instanceRecordId,
			message: `Component "${componentId}" is already being expanded (${[...ctx.stack, componentId].join(" → ")}); placeholder emitted at the recursion boundary.`,
		});
		return instance;
	}
	if (depth > ctx.maxDepth) {
		pushIssue(ctx, {
			code: "component-depth-exceeded",
			severity: "error",
			componentId,
			instanceId: instanceRecordId,
			message: `Nested component depth ${depth} exceeds the cap (${ctx.maxDepth}); placeholder emitted.`,
		});
		return instance;
	}

	const { patches, issues } = applyComponentOverrides(
		definition,
		instance.overrides,
		{ instanceId: instanceRecordId },
	);
	ctx.issues.push(...issues);

	ctx.stack.push(componentId);
	const viewOf = (node: CanvasNode): CanvasNode => patches.get(node.id) ?? node;

	const expandNode = (
		source: CanvasNode,
		virtualId: string,
	): CanvasNode | null => {
		if (ctx.budget.remaining <= 0) {
			if (!ctx.budget.exhausted) {
				ctx.budget.exhausted = true;
				pushIssue(ctx, {
					code: "component-expanded-node-limit",
					severity: "error",
					componentId,
					instanceId: instanceRecordId,
					message:
						"Expansion node budget exhausted; remaining component content is omitted and the document is marked degraded.",
				});
			}
			return null;
		}
		ctx.budget.remaining -= 1;

		const view = viewOf(source);
		if (view.type === "component-instance") {
			const nested = expandInstance(
				ctx,
				view as CanvasComponentInstanceNode,
				[...pathPrefix, source.id],
				depth + 1,
				virtualId,
			);
			const nestedRoot: CanvasNode = { ...nested, id: virtualId } as CanvasNode;
			ctx.origins.set(virtualId, {
				instanceId: instanceRecordId,
				componentId,
				definitionNodeId: source.id,
				depth,
			});
			return nestedRoot;
		}

		let expanded: CanvasNode = { ...view, id: virtualId } as CanvasNode;
		if (isContainerNode(view)) {
			const children: CanvasNode[] = [];
			for (const child of view.children) {
				const childVirtualId = encodeResolvedNodeId({
					segments: [...pathPrefix, child.id],
				}) as string;
				const expandedChild = expandNode(child, childVirtualId);
				if (expandedChild) children.push(expandedChild);
			}
			expanded = { ...expanded, children } as CanvasNode;
		}
		ctx.origins.set(virtualId, {
			instanceId: instanceRecordId,
			componentId,
			definitionNodeId: source.id,
			depth,
		});
		return expanded;
	};

	const sourceRoot = viewOf(definition.root);
	const expandedRoot = expandNode(definition.root, instanceRecordId);
	ctx.stack.pop();
	if (!expandedRoot) return instance;

	// §9.3: the Source root is composed INTO the persistent instance's
	// placement — transform/bounds/allocation and root-level presentation
	// flags come from the instance; content/style/autoLayout stay the
	// Source's (post-override).
	const composedRoot: CanvasNode = {
		...expandedRoot,
		id: instanceRecordId,
		transform: instance.transform,
		bounds: instance.bounds,
		zIndex: instance.zIndex,
		...(instance.name !== undefined ? { name: instance.name } : {}),
		...(instance.opacity !== undefined ? { opacity: instance.opacity } : {}),
		...(instance.visible !== undefined ? { visible: instance.visible } : {}),
		...(instance.locked !== undefined ? { locked: instance.locked } : {}),
		...(instance.layoutItem !== undefined
			? { layoutItem: instance.layoutItem }
			: {}),
	} as CanvasNode;
	ctx.origins.set(instanceRecordId, {
		instanceId: instanceRecordId,
		componentId,
		definitionNodeId: sourceRoot.id,
		depth,
	});
	return composedRoot;
}

/**
 * Resolve ONE instance (T-RES-1): registry lookup → graph/depth/limit
 * validation → override application → nested recursion → virtual subtree +
 * origins + diagnostics + cache key. Pure and deterministic: identical
 * inputs produce identical output, diagnostics in identical order (INV-5).
 */
export function resolveComponentInstance(
	registry: CanvasComponentRegistry | undefined,
	instance: CanvasComponentInstanceNode,
	options: CanvasComponentExpansionOptions = {},
): CanvasResolvedComponentInstance {
	const safeRegistry = registry ?? {};
	const graph = options.graph ?? buildComponentGraph(safeRegistry);
	const issues: CanvasComponentIssue[] = [];
	const origins = new Map<string, CanvasResolvedComponentOrigin>();
	const budget: ExpansionBudget = {
		remaining:
			options.maxExpandedNodes ?? MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
		exhausted: false,
	};

	const definition = safeRegistry[instance.componentId];
	const cacheKey = definition
		? composeCacheKey({
				componentId: instance.componentId,
				// The expansion this key guards is instance-SPECIFIC (its root and
				// every virtual id start from this id), so the id belongs in the key
				// — see `ComponentCacheKeyParts.instanceId`.
				instanceId: instance.id,
				sourceRevision: definition.revision,
				overrideHash: computeOverrideHash(instance.overrides),
				nestedDependencyRevisionHash: computeDependencyRevisionHash(
					instance.componentId,
					safeRegistry,
					graph,
				),
				layoutEngineVersion: options.layoutEngineVersion ?? 1,
				...(options.measurementManifestHash !== undefined
					? { measurementManifestHash: options.measurementManifestHash }
					: {}),
				...(options.assetIntrinsicManifestHash !== undefined
					? {
							assetIntrinsicManifestHash: options.assetIntrinsicManifestHash,
						}
					: {}),
			})
		: "unresolvable";

	const cacheState = options.cache
		? internalCacheState(options.cache)
		: undefined;
	if (cacheState && definition) {
		const hit = cacheState.layers.instance.get(cacheKey) as
			| CanvasResolvedComponentInstance
			| undefined;
		if (hit) return hit;
		// Prime the structural layer while we are here.
		getDefinitionStructure(cacheState, safeRegistry, instance.componentId);
	}

	const ctx: ExpansionContext = {
		registry: safeRegistry,
		graph,
		maxDepth: options.maxDepth ?? MAX_COMPONENT_NESTED_DEPTH,
		budget,
		stack: [],
		issues,
		origins,
	};
	const root = expandInstance(ctx, instance, [instance.id], 1, instance.id);
	const placeholder = root === instance;
	const result: CanvasResolvedComponentInstance = {
		root,
		origins,
		issues,
		cacheKey,
		expandedNodeCount: origins.size,
		placeholder,
	};
	if (cacheState && definition && !placeholder) {
		cacheState.layers.instance.set(cacheKey, result);
	}
	return result;
}
