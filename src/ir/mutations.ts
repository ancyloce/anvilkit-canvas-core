import { resolveNow } from "../clock.js";
import type {
	CanvasContainerNode,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
} from "./types.js";
import {
	CanvasIRDepthError,
	findNode,
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

function isPageRoot(ir: CanvasIR, id: string): boolean {
	return ir.pages.some((p) => p.root.id === id);
}

function replacePage(ir: CanvasIR, page: CanvasPage): CanvasPage[] {
	return ir.pages.map((p) => (p.id === page.id ? page : p));
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

export interface InsertNodeOptions extends NowOption {
	parentId: string;
	node: CanvasNode;
	index?: number;
}

export function insertNode(ir: CanvasIR, options: InsertNodeOptions): CanvasIR {
	let inserted = false;
	const newPages = ir.pages.map((page) => {
		if (inserted) return page;
		// `insertIntoTree` throws (parent-not-group / index-out-of-range) when the
		// parent is found but invalid, and returns the same root reference when the
		// parent is absent from this page.
		const newRoot = insertIntoTree(
			page.root,
			options.parentId,
			options.node,
			options.index,
		);
		if (newRoot !== page.root) {
			inserted = true;
			return { ...page, root: newRoot };
		}
		return page;
	});
	if (!inserted) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`Parent id "${options.parentId}" not found`,
		);
	}
	return {
		...ir,
		pages: newPages,
		metadata: bumpUpdatedAt(ir, options),
	};
}

export interface RemoveNodeOptions extends NowOption {
	id: string;
}

export function removeNode(ir: CanvasIR, options: RemoveNodeOptions): CanvasIR {
	if (isPageRoot(ir, options.id)) {
		throw new CanvasIRMutationError(
			"cannot-remove-page-root",
			`Cannot remove page-root group "${options.id}"`,
		);
	}
	let removedAny = false;
	const newPages = ir.pages.map((page) => {
		if (removedAny) return page;
		const { root: newRoot, removed } = removeIdFromTree(page.root, options.id);
		if (removed) {
			removedAny = true;
			return { ...page, root: newRoot };
		}
		return page;
	});
	if (!removedAny) {
		throw new CanvasIRMutationError(
			"node-not-found",
			`Node id "${options.id}" not found`,
		);
	}
	return {
		...ir,
		pages: newPages,
		metadata: bumpUpdatedAt(ir, options),
	};
}

export interface UpdateNodeOptions<K extends CanvasNodeKind> extends NowOption {
	id: string;
	patch: Partial<Omit<CanvasNodeByKind<K>, "id" | "type">>;
}

export function updateNode<K extends CanvasNodeKind>(
	ir: CanvasIR,
	options: UpdateNodeOptions<K>,
): CanvasIR {
	// A page-root update keeps priority over a same-id descendant (matching the
	// prior `isPageRoot`-first ordering) and preserves the id + type=group invariant.
	const rootPage = ir.pages.find((p) => p.root.id === options.id);
	if (rootPage) {
		const newRoot = mergeNodePatch(
			rootPage.root,
			options.patch,
		) as CanvasGroupNode;
		const newPages = ir.pages.map((p) =>
			p.id === rootPage.id ? { ...p, root: newRoot } : p,
		);
		return {
			...ir,
			pages: newPages,
			metadata: bumpUpdatedAt(ir, options),
		};
	}
	let updated = false;
	const newPages = ir.pages.map((page) => {
		if (updated) return page;
		const newRoot = updateNodeInTree(page.root, options.id, options.patch);
		if (newRoot !== page.root) {
			updated = true;
			return { ...page, root: newRoot };
		}
		return page;
	});
	if (!updated) {
		throw new CanvasIRMutationError(
			"node-not-found",
			`Node id "${options.id}" not found`,
		);
	}
	return {
		...ir,
		pages: newPages,
		metadata: bumpUpdatedAt(ir, options),
	};
}

export interface MoveNodeOptions extends NowOption {
	id: string;
	newParentId: string;
	index?: number;
}

export function moveNode(ir: CanvasIR, options: MoveNodeOptions): CanvasIR {
	if (isPageRoot(ir, options.id)) {
		throw new CanvasIRMutationError(
			"cannot-move-page-root",
			`Cannot move page-root group "${options.id}"`,
		);
	}
	const sourceFound = findNode(ir, options.id);
	if (!sourceFound) {
		throw new CanvasIRMutationError(
			"node-not-found",
			`Node id "${options.id}" not found`,
		);
	}
	const newParentFound = findNode(ir, options.newParentId);
	if (!newParentFound) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`New parent id "${options.newParentId}" not found`,
		);
	}
	if (!isContainerNode(newParentFound.node)) {
		throw new CanvasIRMutationError(
			"parent-not-group",
			`New parent "${options.newParentId}" is not a container (type=${newParentFound.node.type})`,
		);
	}
	// Cycle check: the new parent must not be the moved node or any of its descendants.
	const subtreeIds = descendantIds(sourceFound.node);
	if (subtreeIds.has(options.newParentId)) {
		throw new CanvasIRMutationError(
			"cycle-detected",
			`Moving "${options.id}" into "${options.newParentId}" would create a cycle`,
		);
	}
	// moveNode currently only supports moves within the same page; sourceFound.page must equal newParentFound.page.
	if (sourceFound.page.id !== newParentFound.page.id) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`Cross-page moves are not supported (source page=${sourceFound.page.id}, target page=${newParentFound.page.id})`,
		);
	}
	const page = sourceFound.page;
	const { root: rootMinusSource } = removeIdFromTree(page.root, options.id);
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
	const newParentId = newParent.id;
	const newRoot = replaceContainerInTree(rootMinusSource, newParentId, (c) => {
		const newChildren = [...c.children];
		newChildren.splice(insertIndex, 0, sourceFound.node);
		return { ...c, children: newChildren };
	});
	const newPage: CanvasPage = { ...page, root: newRoot };
	return {
		...ir,
		pages: replacePage(ir, newPage),
		metadata: bumpUpdatedAt(ir, options),
	};
}

export interface ReorderChildrenOptions extends NowOption {
	parentId: string;
	fromIndex: number;
	toIndex: number;
}

export function reorderChildren(
	ir: CanvasIR,
	options: ReorderChildrenOptions,
): CanvasIR {
	const parentInfo = findNode(ir, options.parentId);
	if (!parentInfo) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`Parent id "${options.parentId}" not found`,
		);
	}
	if (!isContainerNode(parentInfo.node)) {
		throw new CanvasIRMutationError(
			"parent-not-group",
			`Parent id "${options.parentId}" is not a container (type=${parentInfo.node.type})`,
		);
	}
	const parent = parentInfo.node;
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
	const page = parentInfo.page;
	const newRoot = replaceContainerInTree(page.root, parent.id, (c) => {
		const newChildren = [...c.children];
		const [moved] = newChildren.splice(options.fromIndex, 1);
		if (!moved) return c;
		newChildren.splice(options.toIndex, 0, moved);
		return { ...c, children: newChildren };
	});
	const newPage: CanvasPage = { ...page, root: newRoot };
	return {
		...ir,
		pages: replacePage(ir, newPage),
		metadata: bumpUpdatedAt(ir, options),
	};
}

export interface ReplaceChildrenInParentOptions extends NowOption {
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
	const parentInfo = findNode(ir, options.parentId);
	if (!parentInfo) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`Parent id "${options.parentId}" not found`,
		);
	}
	if (!isContainerNode(parentInfo.node)) {
		throw new CanvasIRMutationError(
			"parent-not-group",
			`Parent id "${options.parentId}" is not a container (type=${parentInfo.node.type})`,
		);
	}
	const page = parentInfo.page;
	const newRoot = replaceContainerInTree(page.root, options.parentId, (c) => ({
		...c,
		children: options.replace(c.children),
	}));
	const newPage: CanvasPage = { ...page, root: newRoot };
	return {
		...ir,
		pages: replacePage(ir, newPage),
		metadata: bumpUpdatedAt(ir, options),
	};
}
