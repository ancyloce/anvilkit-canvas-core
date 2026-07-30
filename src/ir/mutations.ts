import { resolveNow } from "../clock.js";
import type {
	CanvasComponentDefinition,
	CanvasContainerNode,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
} from "./types.js";
import type { CanvasDocumentLocation } from "./walkers.js";
import {
	CanvasIRDepthError,
	findNodeInSubtree,
	isContainerNode,
	MAX_TREE_DEPTH,
} from "./walkers.js";

export type CanvasIRMutationCode =
	| "node-not-found"
	| "parent-not-found"
	| "parent-not-group"
	| "index-out-of-range"
	| "cannot-remove-page-root"
	| "cannot-move-page-root"
	| "cannot-remove-source-root"
	| "cannot-move-source-root"
	| "invalid-root-replacement"
	| "location-not-found"
	| "cycle-detected";

export class CanvasIRMutationError extends Error {
	readonly code: CanvasIRMutationCode;

	constructor(code: CanvasIRMutationCode, message: string) {
		super(message);
		this.name = "CanvasIRMutationError";
		this.code = code;
	}
}

interface NowOption {
	now?: () => string;
}

function bumpUpdatedAt(ir: CanvasIR, options: NowOption): CanvasIR["metadata"] {
	return { ...ir.metadata, updatedAt: resolveNow(options.now)() };
}

/**
 * Rebuild the document after a node mutation: new pages, a bumped `updatedAt`,
 * and **no materialized-layout stamp**.
 *
 * Every mutation here changes the node tree, which is an input the layout
 * resolver depended on — so a stamp surviving one would claim a freshness it
 * does not have, and `layout-materialization-stale` would never fire for it. A
 * stamp that lies is strictly worse than no stamp (PRD 0014 §9.4).
 *
 * This is a field deletion, not a resolver call: `ir/` is rank 1 and must gain
 * no dependency on `layout/` (rank 4), and does not. It mirrors the identical
 * rule in `commands/runtime.ts`'s `bumpMetadata` — the two exist because node
 * mutations and page/asset commands bump `updatedAt` through different paths,
 * which is exactly why clearing at only one of them left a gap.
 */
function mutatedDocument(
	ir: CanvasIR,
	pages: CanvasPage[],
	options: NowOption,
): CanvasIR {
	const { layoutMaterialization: _invalidated, ...rest } = ir;
	return { ...rest, pages, metadata: bumpUpdatedAt(ir, options) };
}

/**
 * Replace ONE page by reference identity, never by id: a hostile/corrupt
 * document can carry duplicate page ids (the invariant layer flags them, it
 * does not prevent them), and an id-keyed replacement would clobber every
 * same-id page with one tree — silently duplicating node ids. Matches the
 * positional semantics the pre-scope mutation loops had.
 */
function replacePageByIdentity(
	ir: CanvasIR,
	page: CanvasPage,
	next: CanvasPage,
): CanvasPage[] {
	return ir.pages.map((p) => (p === page ? next : p));
}

/**
 * Restricts a mutation to one tree — a page's, or a Component Source's
 * (plan 0023 M3-01, LC-CMD). Absent = every page, the pre-component
 * behavior, so every existing call site keeps its exact semantics.
 */
export interface ScopedMutationOptions extends NowOption {
	location?: CanvasDocumentLocation;
}

/**
 * One candidate tree a mutation may rewrite, plus how to write it back.
 * Pages and Component Sources flow through the SAME tree rewriters — this
 * seam is what keeps the mutation engine single (M3-01: no fork).
 */
interface MutationScope {
	kind: CanvasDocumentLocation["kind"];
	/** Page id or component id — for error messages. */
	id: string;
	root: CanvasNode;
	rootId: string;
	commit(nextRoot: CanvasNode, options: NowOption): CanvasIR;
}

function pageScope(ir: CanvasIR, page: CanvasPage): MutationScope {
	return {
		kind: "page",
		id: page.id,
		root: page.root,
		rootId: page.root.id,
		commit: (nextRoot, options) =>
			mutatedDocument(
				ir,
				// A page root stays a group by contract: every rewriter here
				// preserves the root's discriminant (or is guarded before commit).
				replacePageByIdentity(ir, page, {
					...page,
					root: nextRoot as CanvasGroupNode,
				}),
				options,
			),
	};
}

/**
 * Write-back for a Source tree. Bumps `updatedAt` and drops the
 * materialized-layout stamp exactly like a page mutation (a Source edit
 * changes what every dependent instance resolves to). Deliberately does NOT
 * bump `definition.revision`: the command layer owns the
 * exactly-once-per-command/batch revision contract (M3-02), and bumping in
 * the primitive would double-count multi-step batches.
 */
function componentScope(
	ir: CanvasIR,
	componentId: string,
	definition: CanvasComponentDefinition,
): MutationScope {
	return {
		kind: "component",
		id: componentId,
		root: definition.root,
		rootId: definition.root.id,
		commit: (nextRoot, options) => {
			const { layoutMaterialization: _invalidated, ...rest } = ir;
			return {
				...rest,
				components: {
					...ir.components,
					[componentId]: { ...definition, root: nextRoot },
				},
				metadata: bumpUpdatedAt(ir, options),
			};
		},
	};
}

function resolveScopes(
	ir: CanvasIR,
	location: CanvasDocumentLocation | undefined,
): MutationScope[] {
	if (!location) {
		return ir.pages.map((page) => pageScope(ir, page));
	}
	if (location.kind === "page") {
		const page = ir.pages.find((p) => p.id === location.id);
		if (!page) {
			throw new CanvasIRMutationError(
				"location-not-found",
				`Page "${location.id}" not found`,
			);
		}
		return [pageScope(ir, page)];
	}
	const definition = ir.components?.[location.id];
	if (!definition) {
		throw new CanvasIRMutationError(
			"location-not-found",
			`Component definition "${location.id}" not found`,
		);
	}
	return [componentScope(ir, location.id, definition)];
}

function rootRemoveError(
	scope: MutationScope,
	id: string,
): CanvasIRMutationError {
	return scope.kind === "page"
		? new CanvasIRMutationError(
				"cannot-remove-page-root",
				`Cannot remove page-root group "${id}"`,
			)
		: new CanvasIRMutationError(
				"cannot-remove-source-root",
				`Cannot remove Component Source root "${id}"`,
			);
}

function rootMoveError(
	scope: MutationScope,
	id: string,
): CanvasIRMutationError {
	return scope.kind === "page"
		? new CanvasIRMutationError(
				"cannot-move-page-root",
				`Cannot move page-root group "${id}"`,
			)
		: new CanvasIRMutationError(
				"cannot-move-source-root",
				`Cannot move Component Source root "${id}"`,
			);
}

/**
 * Bound recursion depth so a maliciously/accidentally deep IR cannot overflow
 * the stack inside a mutation. Mirrors the `walkPage` guard (same
 * `MAX_TREE_DEPTH`), so mutations fail the same way reads do.
 */
function assertTreeDepth(depth: number, nodeId: string): void {
	if (depth > MAX_TREE_DEPTH) {
		throw new CanvasIRDepthError([nodeId]);
	}
}

/**
 * The tree helpers below are generic over the container kind (`group` | `frame`)
 * so a rewrite that starts at a page root — always a group, per `CanvasPage` —
 * returns a group, while recursion into a frame child returns a frame. The
 * `replacer` contract is that it preserves the container's discriminant, which
 * every caller here honours (each spreads the container it was handed).
 */
function replaceContainerInTree<T extends CanvasContainerNode>(
	root: T,
	targetId: string,
	replacer: (container: CanvasContainerNode) => CanvasContainerNode,
	depth = 0,
): T {
	assertTreeDepth(depth, root.id);
	if (root.id === targetId) {
		return replacer(root) as T;
	}
	let changed = false;
	const newChildren: CanvasNode[] = root.children.map((child) => {
		if (isContainerNode(child)) {
			const replaced = replaceContainerInTree(
				child,
				targetId,
				replacer,
				depth + 1,
			);
			if (replaced !== child) changed = true;
			return replaced;
		}
		return child;
	});
	if (!changed) return root;
	return { ...root, children: newChildren };
}

function removeIdFromTree<T extends CanvasContainerNode>(
	root: T,
	targetId: string,
	depth = 0,
): { root: T; removed: CanvasNode | null } {
	assertTreeDepth(depth, root.id);
	let removed: CanvasNode | null = null;
	const newChildren: CanvasNode[] = [];
	for (const child of root.children) {
		if (child.id === targetId) {
			removed = child;
			continue;
		}
		if (isContainerNode(child)) {
			const inner = removeIdFromTree(child, targetId, depth + 1);
			if (inner.removed) {
				removed = inner.removed;
				newChildren.push(inner.root);
				continue;
			}
		}
		newChildren.push(child);
	}
	if (!removed) return { root, removed: null };
	return { root: { ...root, children: newChildren }, removed };
}

/**
 * Apply `patch` to `node`, preserving the discriminant + id. A patch entry whose
 * value is `undefined` DELETES that (optional) key rather than setting it to
 * `undefined`, so the inverse of "add an optional field" restores the node's
 * original shape exactly (absent key, not `{ field: undefined }`).
 */
function mergeNodePatch(node: CanvasNode, patch: object): CanvasNode {
	const merged = { ...node, ...patch } as Record<string, unknown>;
	for (const key of Object.keys(patch)) {
		if ((patch as Record<string, unknown>)[key] === undefined) {
			delete merged[key];
		}
	}
	merged.id = node.id;
	merged.type = node.type;
	return merged as unknown as CanvasNode;
}

/**
 * Single-pass immutable node patch. Walks `root` once, rebuilding only the spine
 * down to the first pre-order node whose id matches, and returns the same `root`
 * reference when the id is absent (so callers can detect "not in this page"
 * without a second lookup). Replaces the prior `findNode` + `parentOf` +
 * `replaceGroupInTree` three-walk sequence with one traversal. The discriminant
 * and id are always preserved even if `patch` tries to override them.
 */
function updateNodeInTree<
	T extends CanvasContainerNode,
	K extends CanvasNodeKind,
>(
	container: T,
	id: string,
	patch: Partial<Omit<CanvasNodeByKind<K>, "id" | "type">>,
	depth = 0,
): T {
	assertTreeDepth(depth, container.id);
	let changed = false;
	const newChildren: CanvasNode[] = container.children.map((child) => {
		if (changed) return child;
		if (child.id === id) {
			changed = true;
			return mergeNodePatch(child, patch);
		}
		if (isContainerNode(child)) {
			const replaced = updateNodeInTree(child, id, patch, depth + 1);
			if (replaced !== child) {
				changed = true;
				return replaced;
			}
		}
		return child;
	});
	return changed ? { ...container, children: newChildren } : container;
}

/**
 * Depth of the deepest node in `node`'s own subtree, relative to `node`
 * itself at 0 (a leaf is 0). Used to bound where a subtree may be inserted —
 * see {@link spliceChild} (C-16).
 */
function subtreeDepth(node: CanvasNode): number {
	if (!isContainerNode(node) || node.children.length === 0) return 0;
	let max = 0;
	for (const child of node.children) {
		const d = 1 + subtreeDepth(child);
		if (d > max) max = d;
	}
	return max;
}

/**
 * Single-pass immutable insert. Walks `root` once, splicing `node` into the
 * first pre-order group whose id matches `parentId`, and returns the same `root`
 * reference when `parentId` is absent. Throws `parent-not-group` /
 * `index-out-of-range` when the parent is found but invalid (terminal — the
 * caller must not retry on another page). Replaces the prior `findNode` +
 * `replaceGroupInTree` two-walk sequence with one traversal.
 */
function insertIntoTree<T extends CanvasContainerNode>(
	root: T,
	parentId: string,
	node: CanvasNode,
	index: number | undefined,
	depth = 0,
): T {
	assertTreeDepth(depth, root.id);
	if (root.id === parentId) {
		return spliceChild(root, node, index, depth);
	}
	let changed = false;
	const newChildren: CanvasNode[] = root.children.map((child) => {
		if (changed) return child;
		if (child.id === parentId) {
			if (!isContainerNode(child)) {
				throw new CanvasIRMutationError(
					"parent-not-group",
					`Parent id "${parentId}" is not a container (type=${child.type})`,
				);
			}
			changed = true;
			return spliceChild(child, node, index, depth + 1);
		}
		if (isContainerNode(child)) {
			const replaced = insertIntoTree(child, parentId, node, index, depth + 1);
			if (replaced !== child) {
				changed = true;
				return replaced;
			}
		}
		return child;
	});
	return changed ? { ...root, children: newChildren } : root;
}

/**
 * Insert `node` into `parent.children` at `index` (append when omitted).
 * `parentDepth` is `parent`'s own depth in the tree — combined with `node`'s
 * own subtree depth, this bounds the DEEPEST node the insert would produce,
 * not just the depth of `parent` itself (C-16): inserting a 40-deep subtree
 * under a parent already at depth 30 must be rejected up front, not silently
 * accepted and left for every later reader to trip over.
 */
function spliceChild<T extends CanvasContainerNode>(
	parent: T,
	node: CanvasNode,
	index: number | undefined,
	parentDepth: number,
): T {
	const length = parent.children.length;
	const at = index ?? length;
	if (at < 0 || at > length) {
		throw new CanvasIRMutationError(
			"index-out-of-range",
			`Insert index ${at} out of range for parent with ${length} children`,
		);
	}
	const deepestInsertedDepth = parentDepth + 1 + subtreeDepth(node);
	if (deepestInsertedDepth > MAX_TREE_DEPTH) {
		throw new CanvasIRDepthError([parent.id, node.id]);
	}
	const newChildren = [...parent.children];
	newChildren.splice(at, 0, node);
	return { ...parent, children: newChildren };
}

function descendantIds(node: CanvasNode, depth = 0): Set<string> {
	assertTreeDepth(depth, node.id);
	const out = new Set<string>([node.id]);
	if (isContainerNode(node)) {
		for (const child of node.children) {
			for (const id of descendantIds(child, depth + 1)) {
				out.add(id);
			}
		}
	}
	return out;
}

function findContainerInTree(
	root: CanvasContainerNode,
	id: string,
	depth = 0,
): CanvasContainerNode | null {
	assertTreeDepth(depth, root.id);
	if (root.id === id) return root;
	for (const child of root.children) {
		if (isContainerNode(child)) {
			const inner = findContainerInTree(child, id, depth + 1);
			if (inner) return inner;
		}
	}
	return null;
}

export interface InsertNodeOptions extends ScopedMutationOptions {
	parentId: string;
	node: CanvasNode;
	index?: number;
}

export function insertNode(ir: CanvasIR, options: InsertNodeOptions): CanvasIR {
	for (const scope of resolveScopes(ir, options.location)) {
		if (!isContainerNode(scope.root)) {
			// A leaf Source root cannot take children; any other id is absent here.
			if (scope.rootId === options.parentId) {
				throw new CanvasIRMutationError(
					"parent-not-group",
					`Parent id "${options.parentId}" is not a container (type=${scope.root.type})`,
				);
			}
			continue;
		}
		// `insertIntoTree` throws (parent-not-group / index-out-of-range) when the
		// parent is found but invalid, and returns the same root reference when the
		// parent is absent from this tree.
		const newRoot = insertIntoTree(
			scope.root,
			options.parentId,
			options.node,
			options.index,
		);
		if (newRoot !== scope.root) {
			return scope.commit(newRoot, options);
		}
	}
	throw new CanvasIRMutationError(
		"parent-not-found",
		`Parent id "${options.parentId}" not found`,
	);
}

export interface RemoveNodeOptions extends ScopedMutationOptions {
	id: string;
}

export function removeNode(ir: CanvasIR, options: RemoveNodeOptions): CanvasIR {
	const scopes = resolveScopes(ir, options.location);
	for (const scope of scopes) {
		if (scope.rootId === options.id) {
			throw rootRemoveError(scope, options.id);
		}
	}
	for (const scope of scopes) {
		if (!isContainerNode(scope.root)) continue;
		const { root: newRoot, removed } = removeIdFromTree(scope.root, options.id);
		if (removed) {
			return scope.commit(newRoot, options);
		}
	}
	throw new CanvasIRMutationError(
		"node-not-found",
		`Node id "${options.id}" not found`,
	);
}

export interface UpdateNodeOptions<K extends CanvasNodeKind>
	extends ScopedMutationOptions {
	id: string;
	patch: Partial<Omit<CanvasNodeByKind<K>, "id" | "type">>;
}

export function updateNode<K extends CanvasNodeKind>(
	ir: CanvasIR,
	options: UpdateNodeOptions<K>,
): CanvasIR {
	const scopes = resolveScopes(ir, options.location);
	// A scope-root update keeps priority over a same-id descendant (matching
	// the prior page-root-first ordering); `mergeNodePatch` preserves the id +
	// discriminant, so a page root stays a group and a Source root keeps its kind.
	for (const scope of scopes) {
		if (scope.rootId === options.id) {
			return scope.commit(mergeNodePatch(scope.root, options.patch), options);
		}
	}
	for (const scope of scopes) {
		if (!isContainerNode(scope.root)) continue;
		const newRoot = updateNodeInTree(scope.root, options.id, options.patch);
		if (newRoot !== scope.root) {
			return scope.commit(newRoot, options);
		}
	}
	throw new CanvasIRMutationError(
		"node-not-found",
		`Node id "${options.id}" not found`,
	);
}

export interface MoveNodeOptions extends ScopedMutationOptions {
	id: string;
	newParentId: string;
	index?: number;
}

export function moveNode(ir: CanvasIR, options: MoveNodeOptions): CanvasIR {
	const scopes = resolveScopes(ir, options.location);
	for (const scope of scopes) {
		if (scope.rootId === options.id) {
			throw rootMoveError(scope, options.id);
		}
	}
	let sourceScope: MutationScope | null = null;
	let sourceNode: CanvasNode | null = null;
	let parentScope: MutationScope | null = null;
	let parentNode: CanvasNode | null = null;
	for (const scope of scopes) {
		if (!sourceNode) {
			const found = findNodeInSubtree(scope.root, options.id);
			if (found) {
				sourceScope = scope;
				sourceNode = found.node;
			}
		}
		if (!parentNode) {
			const found = findNodeInSubtree(scope.root, options.newParentId);
			if (found) {
				parentScope = scope;
				parentNode = found.node;
			}
		}
	}
	if (!sourceNode || !sourceScope) {
		throw new CanvasIRMutationError(
			"node-not-found",
			`Node id "${options.id}" not found`,
		);
	}
	if (!parentNode || !parentScope) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`New parent id "${options.newParentId}" not found`,
		);
	}
	if (!isContainerNode(parentNode)) {
		throw new CanvasIRMutationError(
			"parent-not-group",
			`New parent "${options.newParentId}" is not a container (type=${parentNode.type})`,
		);
	}
	// Cycle check: the new parent must not be the moved node or any of its descendants.
	const subtreeIds = descendantIds(sourceNode);
	if (subtreeIds.has(options.newParentId)) {
		throw new CanvasIRMutationError(
			"cycle-detected",
			`Moving "${options.id}" into "${options.newParentId}" would create a cycle`,
		);
	}
	// Moves never cross trees: same-page only (the legacy contract), and a node
	// can never move between a page and a Component Source in one command.
	if (sourceScope !== parentScope) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`Cross-page moves are not supported (source page=${sourceScope.id}, target page=${parentScope.id})`,
		);
	}
	// The scope root is a container here: a leaf-rooted scope could only have
	// matched `id`/`newParentId` at its root, and both root cases threw above
	// (root move guard; parent-not-group for a leaf parent).
	const { root: rootMinusSource } = removeIdFromTree(
		sourceScope.root as CanvasContainerNode,
		options.id,
	);
	// Re-find the new parent in the source-removed tree (reference may have changed).
	const newParent = findContainerInTree(rootMinusSource, options.newParentId);
	if (!newParent) {
		// Should not happen since we validated above and only removed source from siblings.
		throw new CanvasIRMutationError(
			"parent-not-found",
			`New parent "${options.newParentId}" missing after source removal`,
		);
	}
	const newParentChildrenLength = newParent.children.length;
	const insertIndex = options.index ?? newParentChildrenLength;
	if (insertIndex < 0 || insertIndex > newParentChildrenLength) {
		throw new CanvasIRMutationError(
			"index-out-of-range",
			`Insert index ${insertIndex} out of range for parent with ${newParentChildrenLength} children`,
		);
	}
	const movedNode = sourceNode;
	const newRoot = replaceContainerInTree(rootMinusSource, newParent.id, (c) => {
		const newChildren = [...c.children];
		newChildren.splice(insertIndex, 0, movedNode);
		return { ...c, children: newChildren };
	});
	return sourceScope.commit(newRoot, options);
}

export interface ReorderChildrenOptions extends ScopedMutationOptions {
	parentId: string;
	fromIndex: number;
	toIndex: number;
}

export function reorderChildren(
	ir: CanvasIR,
	options: ReorderChildrenOptions,
): CanvasIR {
	for (const scope of resolveScopes(ir, options.location)) {
		const found = findNodeInSubtree(scope.root, options.parentId);
		if (!found) continue;
		if (!isContainerNode(found.node)) {
			throw new CanvasIRMutationError(
				"parent-not-group",
				`Parent id "${options.parentId}" is not a container (type=${found.node.type})`,
			);
		}
		const parent = found.node;
		const length = parent.children.length;
		if (
			options.fromIndex < 0 ||
			options.fromIndex >= length ||
			options.toIndex < 0 ||
			options.toIndex >= length
		) {
			throw new CanvasIRMutationError(
				"index-out-of-range",
				`Reorder indices (${options.fromIndex} → ${options.toIndex}) out of range for parent with ${length} children`,
			);
		}
		// A validated true no-op (parent exists, indices in range, nothing to
		// move) returns the input as-is — no bumped `updatedAt`, no cloned pages
		// — instead of dirtying an otherwise-untouched document (C-6).
		if (options.fromIndex === options.toIndex) {
			return ir;
		}
		// The parent is a container inside this scope, so the scope root is one too.
		const newRoot = replaceContainerInTree(
			scope.root as CanvasContainerNode,
			parent.id,
			(c) => {
				const newChildren = [...c.children];
				const [moved] = newChildren.splice(options.fromIndex, 1);
				if (!moved) return c;
				newChildren.splice(options.toIndex, 0, moved);
				return { ...c, children: newChildren };
			},
		);
		return scope.commit(newRoot, options);
	}
	throw new CanvasIRMutationError(
		"parent-not-found",
		`Parent id "${options.parentId}" not found`,
	);
}

export interface ReplaceChildrenInParentOptions extends ScopedMutationOptions {
	parentId: string;
	/**
	 * Receives the parent container's current children and returns the replacement
	 * array. Runs inside a single tree rewrite, so a batch edit (e.g. grouping or
	 * ungrouping N siblings) costs one O(n) pass instead of N insert/remove
	 * passes. The caller owns IR invariants (unique ids, no cycles) within the
	 * returned array.
	 */
	replace: (children: readonly CanvasNode[]) => CanvasNode[];
}

/**
 * Rewrite a single parent container's `children` in one immutable pass. The
 * building block the command layer uses for batch sibling edits (group /
 * ungroup) so they don't pay one full tree clone per affected child.
 */
export function replaceChildrenInParent(
	ir: CanvasIR,
	options: ReplaceChildrenInParentOptions,
): CanvasIR {
	for (const scope of resolveScopes(ir, options.location)) {
		const found = findNodeInSubtree(scope.root, options.parentId);
		if (!found) continue;
		if (!isContainerNode(found.node)) {
			throw new CanvasIRMutationError(
				"parent-not-group",
				`Parent id "${options.parentId}" is not a container (type=${found.node.type})`,
			);
		}
		// The parent is a container inside this scope, so the scope root is one too.
		const newRoot = replaceContainerInTree(
			scope.root as CanvasContainerNode,
			options.parentId,
			(c) => ({
				...c,
				children: options.replace(c.children),
			}),
		);
		return scope.commit(newRoot, options);
	}
	throw new CanvasIRMutationError(
		"parent-not-found",
		`Parent id "${options.parentId}" not found`,
	);
}

export interface ReplaceNodeOptions extends ScopedMutationOptions {
	id: string;
	node: CanvasNode;
}

/**
 * Replace the subtree rooted at `id` with `node` — id and kind may BOTH
 * change, unlike `updateNode`, which pins them. The building block for
 * detach-style materialization (plan 0023 M3-07): swap one node for another
 * at the exact same tree position. A page root may only be replaced by
 * another group (a page root is a group by contract); a Component Source
 * root may be replaced by any node.
 */
export function replaceNode(
	ir: CanvasIR,
	options: ReplaceNodeOptions,
): CanvasIR {
	const scopes = resolveScopes(ir, options.location);
	for (const scope of scopes) {
		if (scope.rootId === options.id) {
			if (scope.kind === "page" && options.node.type !== "group") {
				throw new CanvasIRMutationError(
					"invalid-root-replacement",
					`Page root "${options.id}" can only be replaced by a group (got type=${options.node.type})`,
				);
			}
			if (subtreeDepth(options.node) > MAX_TREE_DEPTH) {
				throw new CanvasIRDepthError([options.node.id]);
			}
			return scope.commit(options.node, options);
		}
	}
	for (const scope of scopes) {
		if (!isContainerNode(scope.root)) continue;
		const newRoot = replaceChildInTree(scope.root, options.id, options.node);
		if (newRoot !== scope.root) {
			return scope.commit(newRoot, options);
		}
	}
	throw new CanvasIRMutationError(
		"node-not-found",
		`Node id "${options.id}" not found`,
	);
}

/**
 * Single-pass immutable whole-node replacement (id/kind free to change,
 * unlike `updateNodeInTree`). Returns the same `root` reference when `id` is
 * absent. Depth-bounds the REPLACEMENT subtree at its insertion depth, so a
 * swap can never smuggle in a tree deeper than an insert could (C-16).
 */
function replaceChildInTree<T extends CanvasContainerNode>(
	container: T,
	id: string,
	replacement: CanvasNode,
	depth = 0,
): T {
	assertTreeDepth(depth, container.id);
	let changed = false;
	const newChildren: CanvasNode[] = container.children.map((child) => {
		if (changed) return child;
		if (child.id === id) {
			const deepestReplacedDepth = depth + 1 + subtreeDepth(replacement);
			if (deepestReplacedDepth > MAX_TREE_DEPTH) {
				throw new CanvasIRDepthError([container.id, replacement.id]);
			}
			changed = true;
			return replacement;
		}
		if (isContainerNode(child)) {
			const replaced = replaceChildInTree(child, id, replacement, depth + 1);
			if (replaced !== child) {
				changed = true;
				return replaced;
			}
		}
		return child;
	});
	return changed ? { ...container, children: newChildren } : container;
}
