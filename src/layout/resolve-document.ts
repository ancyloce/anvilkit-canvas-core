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
import { adoptResolutionState, resolveCanvasLayout } from "./resolve.js";
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
		return withResolutionState(resolved, { ...resolved, componentIssues: [] });
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
		return withResolutionState(resolved, {
			...resolved,
			componentIssues: issues,
		});
	}
	const records = new Map(resolved.records);
	for (const [id, origin] of origins) {
		const key = toResolvedNodeId(id);
		const record = records.get(key);
		if (!record) continue;
		records.set(key, attachOrigin(record, origin));
	}
	return withResolutionState(resolved, {
		...resolved,
		records,
		componentIssues: issues,
	});
}

/**
 * Carry the solver's private per-document state (warm cache, reuse count,
 * manifest stamp) onto the additive copy this file returns, and hand the copy
 * back.
 *
 * Every `return` here spreads the layout result to attach `componentIssues`,
 * which breaks the object identity those lookups are keyed by — see
 * {@link adoptResolutionState}. Threading it through one helper is what keeps a
 * future extra return path from silently reintroducing a cold-resolve
 * regression.
 */
function withResolutionState(
	from: CanvasResolvedDocument,
	to: CanvasResolvedComponentDocument,
): CanvasResolvedComponentDocument {
	adoptResolutionState(from, to);
	return to;
}

/**
 * Provenance-wrapped records, memoised on the PLAIN record they wrap.
 *
 * Attaching `component` means spreading the solver's record, which allocates a
 * new object — so without this memo every virtual record's identity changed on
 * every resolution even when nothing about it moved, and the incremental
 * contract (TD §5.4: "untouched records are reference-identical between
 * consecutive resolutions, which is also what lets renderers memoise on record
 * identity") held for plain nodes but silently NOT for component ones. The
 * visible consequence is every instance re-rendering on every pointer move,
 * rather than only the instances a Source edit actually dirtied.
 *
 * Keyed on the solver's own record object, which is safe because the solver
 * caches only plain records: its warm state is built from the map it emitted
 * itself, never from this file's wrapped copies. So a warm pass hands back the
 * identical plain record, which finds the identical wrapper here.
 */
const originWraps = new WeakMap<
	CanvasResolvedNodeRecord,
	CanvasResolvedNodeRecord
>();

function sameOrigin(
	a: CanvasResolvedComponentOrigin | undefined,
	b: CanvasResolvedComponentOrigin,
): boolean {
	return (
		a !== undefined &&
		a.instanceId === b.instanceId &&
		a.componentId === b.componentId &&
		a.definitionNodeId === b.definitionNodeId &&
		a.depth === b.depth
	);
}

function attachOrigin(
	record: CanvasResolvedNodeRecord,
	origin: CanvasResolvedComponentOrigin,
): CanvasResolvedNodeRecord {
	const cached = originWraps.get(record);
	// Re-verify the provenance rather than trusting the memo: the same plain
	// record could in principle be re-emitted under a different instance, and a
	// wrapper carrying the wrong `component` would misattribute a virtual node.
	if (cached && sameOrigin(cached.component, origin)) return cached;
	const wrapped: CanvasResolvedNodeRecord = { ...record, component: origin };
	originWraps.set(record, wrapped);
	return wrapped;
}
