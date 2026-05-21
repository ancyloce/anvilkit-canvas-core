import { findNode, isGroupNode, parentOf, walkPage } from "./ir-walkers.js";
import type {
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
} from "./types.js";

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

function nowIso(): string {
	return new Date().toISOString();
}

function bumpUpdatedAt(ir: CanvasIR, options: NowOption): CanvasIR["metadata"] {
	const now = options.now ?? nowIso;
	return { ...ir.metadata, updatedAt: now() };
}

function isPageRoot(ir: CanvasIR, id: string): boolean {
	return ir.pages.some((p) => p.root.id === id);
}

function replacePage(ir: CanvasIR, page: CanvasPage): CanvasPage[] {
	return ir.pages.map((p) => (p.id === page.id ? page : p));
}

function replaceGroupInTree(
	root: CanvasGroupNode,
	targetId: string,
	replacer: (group: CanvasGroupNode) => CanvasGroupNode,
): CanvasGroupNode {
	if (root.id === targetId) {
		return replacer(root);
	}
	let changed = false;
	const newChildren: CanvasNode[] = root.children.map((child) => {
		if (isGroupNode(child)) {
			const replaced = replaceGroupInTree(child, targetId, replacer);
			if (replaced !== child) changed = true;
			return replaced;
		}
		return child;
	});
	if (!changed) return root;
	return { ...root, children: newChildren };
}

function removeIdFromTree(
	root: CanvasGroupNode,
	targetId: string,
): { root: CanvasGroupNode; removed: CanvasNode | null } {
	let removed: CanvasNode | null = null;
	const newChildren: CanvasNode[] = [];
	for (const child of root.children) {
		if (child.id === targetId) {
			removed = child;
			continue;
		}
		if (isGroupNode(child)) {
			const inner = removeIdFromTree(child, targetId);
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

function descendantIds(node: CanvasNode): Set<string> {
	const out = new Set<string>([node.id]);
	if (isGroupNode(node)) {
		for (const child of node.children) {
			for (const id of descendantIds(child)) {
				out.add(id);
			}
		}
	}
	return out;
}

function findGroupInTree(
	root: CanvasGroupNode,
	id: string,
): CanvasGroupNode | null {
	if (root.id === id) return root;
	for (const child of root.children) {
		if (isGroupNode(child)) {
			const inner = findGroupInTree(child, id);
			if (inner) return inner;
		}
	}
	return null;
}

function pageContaining(ir: CanvasIR, id: string): CanvasPage | null {
	for (const page of ir.pages) {
		let found = false;
		walkPage(page, ({ node }) => {
			if (node.id === id) found = true;
		});
		if (found) return page;
	}
	return null;
}

export interface InsertNodeOptions extends NowOption {
	parentId: string;
	node: CanvasNode;
	index?: number;
}

export function insertNode(ir: CanvasIR, options: InsertNodeOptions): CanvasIR {
	const parentInfo = findNode(ir, options.parentId);
	if (!parentInfo) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`Parent id "${options.parentId}" not found`,
		);
	}
	if (!isGroupNode(parentInfo.node)) {
		throw new CanvasIRMutationError(
			"parent-not-group",
			`Parent id "${options.parentId}" is not a group (type=${parentInfo.node.type})`,
		);
	}
	const parent = parentInfo.node;
	const insertIndex = options.index ?? parent.children.length;
	if (insertIndex < 0 || insertIndex > parent.children.length) {
		throw new CanvasIRMutationError(
			"index-out-of-range",
			`Insert index ${insertIndex} out of range for parent with ${parent.children.length} children`,
		);
	}
	const page = parentInfo.page;
	const newRoot = replaceGroupInTree(page.root, parent.id, (g) => {
		const newChildren = [...g.children];
		newChildren.splice(insertIndex, 0, options.node);
		return { ...g, children: newChildren };
	});
	const newPage: CanvasPage = { ...page, root: newRoot };
	return {
		...ir,
		pages: replacePage(ir, newPage),
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
	const found = findNode(ir, options.id);
	if (!found) {
		throw new CanvasIRMutationError(
			"node-not-found",
			`Node id "${options.id}" not found`,
		);
	}
	const { root: newRoot, removed } = removeIdFromTree(
		found.page.root,
		options.id,
	);
	if (!removed) {
		throw new CanvasIRMutationError(
			"node-not-found",
			`Node id "${options.id}" not found inside page "${found.page.id}"`,
		);
	}
	const newPage: CanvasPage = { ...found.page, root: newRoot };
	return {
		...ir,
		pages: replacePage(ir, newPage),
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
	const found = findNode(ir, options.id);
	if (!found) {
		throw new CanvasIRMutationError(
			"node-not-found",
			`Node id "${options.id}" not found`,
		);
	}
	const page = found.page;
	const target = found.node;
	if (isPageRoot(ir, options.id)) {
		const newRoot = { ...page.root, ...options.patch } as CanvasGroupNode;
		// Always preserve id + type + children invariant.
		newRoot.id = target.id;
		newRoot.type = "group";
		const newPage: CanvasPage = { ...page, root: newRoot };
		return {
			...ir,
			pages: replacePage(ir, newPage),
			metadata: bumpUpdatedAt(ir, options),
		};
	}
	const parentResult = parentOf(ir, options.id);
	if (!parentResult) {
		// Should be unreachable since we know it's not a page-root and findNode succeeded.
		throw new CanvasIRMutationError(
			"parent-not-found",
			`Parent of node "${options.id}" not found`,
		);
	}
	const parent = parentResult.parent;
	const newRoot = replaceGroupInTree(page.root, parent.id, (g) => {
		const newChildren = g.children.map((child) => {
			if (child.id !== options.id) return child;
			const merged = { ...child, ...options.patch } as CanvasNode;
			// Preserve discriminant + id even if patch tried to override (Partial<Omit> already forbids this at the type level, but defend at runtime too).
			merged.id = child.id;
			merged.type = child.type;
			return merged;
		});
		return { ...g, children: newChildren };
	});
	const newPage: CanvasPage = { ...page, root: newRoot };
	return {
		...ir,
		pages: replacePage(ir, newPage),
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
	if (!isGroupNode(newParentFound.node)) {
		throw new CanvasIRMutationError(
			"parent-not-group",
			`New parent "${options.newParentId}" is not a group (type=${newParentFound.node.type})`,
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
	const newParent = findGroupInTree(rootMinusSource, options.newParentId);
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
	const newRoot = replaceGroupInTree(rootMinusSource, newParentId, (g) => {
		const newChildren = [...g.children];
		newChildren.splice(insertIndex, 0, sourceFound.node);
		return { ...g, children: newChildren };
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
	if (options.fromIndex === options.toIndex) {
		return {
			...ir,
			metadata: bumpUpdatedAt(ir, options),
		};
	}
	const parentInfo = findNode(ir, options.parentId);
	if (!parentInfo) {
		throw new CanvasIRMutationError(
			"parent-not-found",
			`Parent id "${options.parentId}" not found`,
		);
	}
	if (!isGroupNode(parentInfo.node)) {
		throw new CanvasIRMutationError(
			"parent-not-group",
			`Parent id "${options.parentId}" is not a group`,
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
	const page = parentInfo.page;
	const newRoot = replaceGroupInTree(page.root, parent.id, (g) => {
		const newChildren = [...g.children];
		const [moved] = newChildren.splice(options.fromIndex, 1);
		if (!moved) return g;
		newChildren.splice(options.toIndex, 0, moved);
		return { ...g, children: newChildren };
	});
	const newPage: CanvasPage = { ...page, root: newRoot };
	return {
		...ir,
		pages: replacePage(ir, newPage),
		metadata: bumpUpdatedAt(ir, options),
	};
}

// Internal helper exported for tests + walkers; not part of the public mutation surface.
export const __internal = {
	pageContaining,
	descendantIds,
};
