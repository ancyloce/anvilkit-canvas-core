/**
 * @file The composed document resolver (plan 0023 M2-06, TD §2.7/§9.1).
 *
 * ONE composition, frozen order: component expansion strictly BEFORE
 * `resolveCanvasLayout` — internal Auto Layout runs over post-override
 * content, which is what makes a text override change a Hug ancestor's size
 * (T-AL-1). This ADDS TO the layout resolver rather than replacing it: a
 * component-free document short-circuits to `resolveCanvasLayout(ir,
 * options)` and its output is the identical object, byte for byte.
 *
 * Lives in `layout/` (rank 4), not `components/` (rank 2), because the
 * composition calls the solver and rank 2 cannot import upward (DEV-M2-A) —
 * the same layering rule that put the persisted component shapes in `ir/`.
 */

import type { CanvasComponentResolutionCache } from "../components/cache.js";
import { createComponentResolutionCache } from "../components/cache.js";
import { buildComponentGraph } from "../components/graph.js";
import { toResolvedNodeId } from "../components/identity.js";
import {
	type CanvasResolvedComponentInstance,
	resolveComponentInstance,
} from "../components/resolve.js";
import type {
	CanvasComponentIssue,
	CanvasResolvedComponentOrigin,
} from "../components/types.js";
import type {
	CanvasComponentInstanceNode,
	CanvasIR,
	CanvasNode,
	CanvasPage,
} from "../ir/types.js";
import { isContainerNode } from "../ir/walkers.js";
import { MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION } from "../limits.js";
import { resolveCanvasLayout } from "./resolve.js";
import type {
	CanvasLayoutResolveOptions,
	CanvasResolvedDocument,
	CanvasResolvedNodeRecord,
} from "./types.js";

export interface CanvasComponentResolveOptions
	extends CanvasLayoutResolveOptions {
	/** Session component cache; a private one is created per call when absent. */
	readonly componentCache?: CanvasComponentResolutionCache;
	/** Document-wide expansion budget. Defaults to the D-3 cap. */
	readonly maxExpandedNodes?: number;
	/** Nested component depth cap. Defaults to `MAX_COMPONENT_NESTED_DEPTH`. */
	readonly maxComponentDepth?: number;
}

/**
 * `CanvasResolvedDocument` plus the component diagnostics of the expansion
 * pass. Additive subtype: every existing consumer of the base type keeps
 * working unchanged.
 */
export interface CanvasResolvedComponentDocument
	extends CanvasResolvedDocument {
	readonly componentIssues: readonly CanvasComponentIssue[];
}

function pageHasInstance(page: CanvasPage): boolean {
	const stack: CanvasNode[] = [page.root];
	while (stack.length > 0) {
		const node = stack.pop() as CanvasNode;
		if (node.type === "component-instance") return true;
		if (isContainerNode(node)) {
			for (const child of node.children) stack.push(child);
		}
	}
	return false;
}

/**
 * Resolve a document END TO END: expand every component instance into its
 * virtual subtree, then run the Auto Layout solver over the expanded
 * document, then attach provenance to every virtual record. The ONLY
 * resolution path renderers, hit testing, a11y, and export may use
 * (PRD §9.13) — never `resolveCanvasLayout` directly for component-bearing
 * documents.
 */
export function resolveCanvasDocument(
	ir: CanvasIR,
	options: CanvasComponentResolveOptions = {},
): CanvasResolvedComponentDocument {
	const registry = ir.components;
	const pages = options.pageIds
		? ir.pages.filter((p) => options.pageIds?.includes(p.id))
		: ir.pages;
	const anyInstances = pages.some(pageHasInstance);

	// Component-free fast path: the layout result IS the result, identical
	// object modulo the (empty) componentIssues field.
	if (!anyInstances) {
		const resolved = resolveCanvasLayout(ir, options);
		return { ...resolved, componentIssues: [] };
	}

	const cache = options.componentCache ?? createComponentResolutionCache();
	const graph = buildComponentGraph(registry ?? {});
	const issues: CanvasComponentIssue[] = [];
	const origins = new Map<string, CanvasResolvedComponentOrigin>();
	const budgetCap =
		options.maxExpandedNodes ?? MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION;
	let expanded = 0;

	const expandTree = (node: CanvasNode): CanvasNode => {
		if (node.type === "component-instance") {
			const result: CanvasResolvedComponentInstance = resolveComponentInstance(
				registry,
				node as CanvasComponentInstanceNode,
				{
					cache,
					graph,
					maxExpandedNodes: Math.max(0, budgetCap - expanded),
					...(options.maxComponentDepth !== undefined
						? { maxDepth: options.maxComponentDepth }
						: {}),
					...(options.measurement?.manifestHash !== undefined
						? {
								measurementManifestHash: options.measurement.manifestHash,
							}
						: {}),
				},
			);
			expanded += result.expandedNodeCount;
			issues.push(...result.issues);
			for (const [id, origin] of result.origins) origins.set(id, origin);
			return result.root;
		}
		if (!isContainerNode(node)) return node;
		let changed = false;
		const children = node.children.map((child) => {
			const next = expandTree(child);
			if (next !== child) changed = true;
			return next;
		});
		return changed ? ({ ...node, children } as CanvasNode) : node;
	};

	const expandedPages = ir.pages.map((page) => {
		if (options.pageIds && !options.pageIds.includes(page.id)) return page;
		const root = expandTree(page.root);
		return root === page.root
			? page
			: { ...page, root: root as CanvasPage["root"] };
	});
	const expandedIr: CanvasIR = { ...ir, pages: expandedPages };

	const resolved = resolveCanvasLayout(expandedIr, options);

	if (origins.size === 0) {
		return { ...resolved, componentIssues: issues };
	}
	const records = new Map(resolved.records);
	for (const [id, origin] of origins) {
		const key = toResolvedNodeId(id);
		const record = records.get(key);
		if (!record) continue;
		const withOrigin: CanvasResolvedNodeRecord = {
			...record,
			component: origin,
		};
		records.set(key, withOrigin);
	}
	return { ...resolved, records, componentIssues: issues };
}
