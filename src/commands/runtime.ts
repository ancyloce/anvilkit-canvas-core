import { resolveNow } from "../clock.js";
import { transformedBoundsExtent } from "../geometry/affine.js";
import {
	CanvasIRMutationError,
	insertNode,
	removeNode,
	reorderChildren,
	replaceChildrenInParent,
	updateNode,
} from "../ir/mutations.js";
import type {
	CanvasBounds,
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
} from "../ir/types.js";
import { findNode, parentOf } from "../ir/walkers.js";
import type {
	CanvasAnyNodeUpdateCommand,
	CanvasBatchCommand,
	CanvasCommand,
	CanvasImageReplaceCommand,
	CanvasNodeCreateCommand,
	CanvasNodeDeleteCommand,
	CanvasNodeGroupCommand,
	CanvasNodeMoveCommand,
	CanvasNodeReorderCommand,
	CanvasNodeResizeCommand,
	CanvasNodeRotateCommand,
	CanvasNodeUngroupCommand,
	CanvasPageCreateCommand,
	CanvasPageDeleteCommand,
	CanvasPageRenameCommand,
	CanvasPageReorderCommand,
	CommandApplyOptions,
	CommandApplyResult,
} from "./types.js";

export type CanvasCommandErrorCode =
	| "node-not-found"
	| "parent-not-found"
	| "parent-not-group"
	| "page-not-found"
	| "kind-mismatch"
	| "asset-mismatch"
	| "index-out-of-range"
	| "invariant-violated";

export class CanvasCommandError extends Error {
	readonly code: CanvasCommandErrorCode;

	constructor(code: CanvasCommandErrorCode, message: string) {
		super(message);
		this.name = "CanvasCommandError";
		this.code = code;
	}
}

function bumpMetadata(ir: CanvasIR, options: CommandApplyOptions): CanvasIR {
	return {
		...ir,
		metadata: { ...ir.metadata, updatedAt: resolveNow(options.now)() },
	};
}

function expectPage(ir: CanvasIR, pageId: string): CanvasPage {
	const page = ir.pages.find((p) => p.id === pageId);
	if (!page) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${pageId}" not found`,
		);
	}
	return page;
}

function expectNode(
	ir: CanvasIR,
	id: string,
): { node: CanvasNode; page: CanvasPage } {
	const found = findNode(ir, id);
	if (!found) {
		throw new CanvasCommandError("node-not-found", `Node id "${id}" not found`);
	}
	return found;
}

function rethrowMutationError(err: unknown): never {
	if (err instanceof CanvasIRMutationError) {
		switch (err.code) {
			case "node-not-found":
				throw new CanvasCommandError("node-not-found", err.message);
			case "parent-not-found":
				throw new CanvasCommandError("parent-not-found", err.message);
			// Removing/moving a page root is an invariant violation, not a missing
			// parent — surface it distinctly so callers can tell the two apart.
			case "cannot-remove-page-root":
			case "cannot-move-page-root":
				throw new CanvasCommandError("invariant-violated", err.message);
			case "parent-not-group":
				throw new CanvasCommandError("parent-not-group", err.message);
			case "index-out-of-range":
				throw new CanvasCommandError("index-out-of-range", err.message);
			case "cycle-detected":
				throw new CanvasCommandError("invariant-violated", err.message);
		}
	}
	throw err;
}

function resolveParentId(
	ir: CanvasIR,
	pageId: string,
	parentId: string | undefined,
): string {
	const page = expectPage(ir, pageId);
	return parentId ?? page.root.id;
}

function locateSiblingIndex(parent: CanvasGroupNode, childId: string): number {
	const idx = parent.children.findIndex((c) => c.id === childId);
	if (idx < 0) {
		throw new CanvasCommandError(
			"node-not-found",
			`Node "${childId}" not found under parent "${parent.id}"`,
		);
	}
	return idx;
}

function applyNodeCreate(
	ir: CanvasIR,
	cmd: CanvasNodeCreateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const parentId = resolveParentId(ir, cmd.pageId, cmd.parentId);
	let next: CanvasIR;
	try {
		next = insertNode(ir, {
			parentId,
			node: cmd.node,
			...(cmd.index !== undefined ? { index: cmd.index } : {}),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeDeleteCommand = {
		type: "node.delete",
		nodeId: cmd.node.id,
	};
	return { ir: next, inverse };
}

function applyNodeDelete(
	ir: CanvasIR,
	cmd: CanvasNodeDeleteCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const { node, page } = expectNode(ir, cmd.nodeId);
	const parentResult = parentOf(ir, cmd.nodeId);
	if (!parentResult) {
		throw new CanvasCommandError(
			"parent-not-found",
			`Node "${cmd.nodeId}" has no parent (likely a page root)`,
		);
	}
	const parent = parentResult.parent;
	const index = locateSiblingIndex(parent, cmd.nodeId);
	let next: CanvasIR;
	try {
		next = removeNode(ir, { id: cmd.nodeId, now: options.now });
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeCreateCommand = {
		type: "node.create",
		node,
		pageId: page.id,
		parentId: parent.id,
		index,
	};
	return { ir: next, inverse };
}

function applyNodeMove(
	ir: CanvasIR,
	cmd: CanvasNodeMoveCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const { node } = expectNode(ir, cmd.nodeId);
	const currentX = node.transform.x;
	const currentY = node.transform.y;
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: {
				transform: { ...node.transform, x: cmd.to.x, y: cmd.to.y },
			} as Partial<Omit<CanvasNode, "id" | "type">>,
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeMoveCommand = {
		type: "node.move",
		nodeId: cmd.nodeId,
		from: { x: cmd.to.x, y: cmd.to.y },
		to: { x: currentX, y: currentY },
	};
	return { ir: next, inverse };
}

function applyNodeResize(
	ir: CanvasIR,
	cmd: CanvasNodeResizeCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const { node } = expectNode(ir, cmd.nodeId);
	const currentX = node.transform.x;
	const currentY = node.transform.y;
	const currentW = node.bounds.width;
	const currentH = node.bounds.height;
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: {
				transform: { ...node.transform, x: cmd.to.x, y: cmd.to.y },
				bounds: { width: cmd.to.width, height: cmd.to.height },
			} as Partial<Omit<CanvasNode, "id" | "type">>,
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeResizeCommand = {
		type: "node.resize",
		nodeId: cmd.nodeId,
		from: {
			x: cmd.to.x,
			y: cmd.to.y,
			width: cmd.to.width,
			height: cmd.to.height,
		},
		to: {
			x: currentX,
			y: currentY,
			width: currentW,
			height: currentH,
		},
	};
	return { ir: next, inverse };
}

function applyNodeRotate(
	ir: CanvasIR,
	cmd: CanvasNodeRotateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const { node } = expectNode(ir, cmd.nodeId);
	const currentRotation = node.transform.rotation;
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: {
				transform: { ...node.transform, rotation: cmd.to },
			} as Partial<Omit<CanvasNode, "id" | "type">>,
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeRotateCommand = {
		type: "node.rotate",
		nodeId: cmd.nodeId,
		from: cmd.to,
		to: currentRotation,
	};
	return { ir: next, inverse };
}

function applyNodeUpdate(
	ir: CanvasIR,
	cmd: CanvasAnyNodeUpdateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const { node } = expectNode(ir, cmd.nodeId);
	if (node.type !== cmd.kind) {
		throw new CanvasCommandError(
			"kind-mismatch",
			`Node "${cmd.nodeId}" is of kind "${node.type}", not "${cmd.kind}"`,
		);
	}
	// Capture inverse patch: for each key in cmd.patch, record the prior value.
	const patch = cmd.patch as Record<string, unknown>;
	const inversePatch: Record<string, unknown> = {};
	const nodeRecord = node as unknown as Record<string, unknown>;
	for (const key of Object.keys(patch)) {
		inversePatch[key] = nodeRecord[key];
	}
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: cmd.patch as Partial<Omit<CanvasNode, "id" | "type">>,
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse = {
		type: "node.update",
		nodeId: cmd.nodeId,
		kind: cmd.kind,
		patch: inversePatch as Partial<
			Omit<CanvasNodeByKind<CanvasNodeKind>, "id" | "type">
		>,
	} as CanvasAnyNodeUpdateCommand;
	return { ir: next, inverse };
}

function applyImageReplace(
	ir: CanvasIR,
	cmd: CanvasImageReplaceCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const { node } = expectNode(ir, cmd.nodeId);
	if (node.type !== "image") {
		throw new CanvasCommandError(
			"kind-mismatch",
			`Node "${cmd.nodeId}" is of kind "${node.type}", not "image"`,
		);
	}
	const imageNode = node as CanvasImageNode;
	if (imageNode.assetId !== cmd.fromAssetId) {
		throw new CanvasCommandError(
			"asset-mismatch",
			`Image node "${cmd.nodeId}" assetId "${imageNode.assetId}" does not match expected "${cmd.fromAssetId}"`,
		);
	}
	let next: CanvasIR;
	try {
		next = updateNode<"image">(ir, {
			id: cmd.nodeId,
			patch: { assetId: cmd.toAssetId },
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasImageReplaceCommand = {
		type: "image.replace",
		nodeId: cmd.nodeId,
		fromAssetId: cmd.toAssetId,
		toAssetId: cmd.fromAssetId,
	};
	return { ir: next, inverse };
}

function computeChildrenBounds(children: readonly CanvasNode[]): CanvasBounds {
	// Transform-aware AABB across all children (accounts for rotation/scale/skew,
	// not just `x + width`), anchored to include the group origin (0,0). So
	// positive-coord content still measures from 0, while rotated/scaled content
	// that spills into negative coordinates is fully covered.
	let minX = 0;
	let minY = 0;
	let maxX = 0;
	let maxY = 0;
	for (const child of children) {
		const ext = transformedBoundsExtent(
			child.transform,
			child.bounds.width,
			child.bounds.height,
		);
		if (ext.minX < minX) minX = ext.minX;
		if (ext.minY < minY) minY = ext.minY;
		if (ext.maxX > maxX) maxX = ext.maxX;
		if (ext.maxY > maxY) maxY = ext.maxY;
	}
	return { width: maxX - minX, height: maxY - minY };
}

interface GroupChildEntry {
	id: string;
	node: CanvasNode;
	index: number;
}

function applyNodeGroup(
	ir: CanvasIR,
	cmd: CanvasNodeGroupCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	if (cmd.childIds.length === 0) {
		throw new CanvasCommandError(
			"invariant-violated",
			"node.group requires at least one childId",
		);
	}
	const uniqueIds = new Set(cmd.childIds);
	if (uniqueIds.size !== cmd.childIds.length) {
		throw new CanvasCommandError(
			"invariant-violated",
			"node.group childIds contains duplicates",
		);
	}
	const page = expectPage(ir, cmd.pageId);
	if (findNode(ir, cmd.groupId)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Group id "${cmd.groupId}" already exists`,
		);
	}
	let parent: CanvasGroupNode | undefined;
	const entries: GroupChildEntry[] = [];
	for (const id of cmd.childIds) {
		const found = findNode(ir, id);
		if (!found || found.page.id !== page.id) {
			throw new CanvasCommandError(
				"node-not-found",
				`Node "${id}" not found on page "${cmd.pageId}"`,
			);
		}
		const parentResult = parentOf(ir, id);
		if (!parentResult) {
			throw new CanvasCommandError(
				"invariant-violated",
				`Cannot group page-root node "${id}"`,
			);
		}
		if (parent === undefined) {
			parent = parentResult.parent;
		} else if (parent.id !== parentResult.parent.id) {
			throw new CanvasCommandError(
				"invariant-violated",
				"node.group requires all childIds to share the same parent",
			);
		}
		const index = parentResult.parent.children.findIndex((c) => c.id === id);
		entries.push({ id, node: found.node, index });
	}
	if (parent === undefined) {
		throw new CanvasCommandError(
			"invariant-violated",
			"node.group could not resolve a parent",
		);
	}
	entries.sort((a, b) => a.index - b.index);
	const firstEntry = entries[0];
	if (!firstEntry) {
		throw new CanvasCommandError(
			"invariant-violated",
			"node.group resolved no children",
		);
	}
	const minIndex = firstEntry.index;
	const childNodes = entries.map((e) => e.node);
	const groupNode: CanvasGroupNode = cmd.groupTemplate
		? {
				...cmd.groupTemplate,
				id: cmd.groupId,
				type: "group",
				children: childNodes,
			}
		: {
				id: cmd.groupId,
				type: "group",
				...(cmd.groupName !== undefined ? { name: cmd.groupName } : {}),
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: computeChildrenBounds(childNodes),
				zIndex: 0,
				children: childNodes,
			};
	const parentId = parent.id;
	const selectedIds = new Set(cmd.childIds);
	let next: CanvasIR;
	try {
		// Single tree rewrite: drop the selected siblings and splice the new group
		// in at the topmost selected slot — one O(n) pass, not one per child.
		next = replaceChildrenInParent(ir, {
			parentId,
			replace: (children) => {
				const remaining = children.filter((c) => !selectedIds.has(c.id));
				remaining.splice(minIndex, 0, groupNode);
				return remaining;
			},
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeUngroupCommand = {
		type: "node.ungroup",
		groupId: cmd.groupId,
		restore: entries.map((e) => ({ id: e.id, index: e.index })),
	};
	return { ir: next, inverse };
}

function applyNodeUngroup(
	ir: CanvasIR,
	cmd: CanvasNodeUngroupCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const found = expectNode(ir, cmd.groupId);
	if (found.node.type !== "group") {
		throw new CanvasCommandError(
			"kind-mismatch",
			`Node "${cmd.groupId}" is of kind "${found.node.type}", not "group"`,
		);
	}
	const group = found.node;
	const parentResult = parentOf(ir, cmd.groupId);
	if (!parentResult) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Cannot ungroup parentless group "${cmd.groupId}" (likely a page root)`,
		);
	}
	const parent = parentResult.parent;
	const groupIndex = parent.children.findIndex((c) => c.id === cmd.groupId);
	const children = group.children;
	const childIds = children.map((c) => c.id);
	const { children: _children, ...groupTemplate } = group;
	const parentId = parent.id;
	const restore = cmd.restore;
	// Pre-validate restore ids so the failure path is independent of the rewrite.
	if (restore && restore.length > 0) {
		for (const { id } of restore) {
			if (!children.some((c) => c.id === id)) {
				throw new CanvasCommandError(
					"invariant-violated",
					`Restore id "${id}" is not a child of group "${cmd.groupId}"`,
				);
			}
		}
	}
	let next: CanvasIR;
	try {
		// Single tree rewrite: replace the group with its children spilled into the
		// parent — at their recorded indices when restoring, else contiguously at
		// the group's former slot.
		next = replaceChildrenInParent(ir, {
			parentId,
			replace: (siblings) => {
				const withoutGroup = siblings.filter((c) => c.id !== cmd.groupId);
				const result = [...withoutGroup];
				if (restore && restore.length > 0) {
					const plan = [...restore].sort((a, b) => a.index - b.index);
					for (const { id, index } of plan) {
						const child = children.find((c) => c.id === id);
						if (child) result.splice(index, 0, child);
					}
					return result;
				}
				result.splice(groupIndex, 0, ...children);
				return result;
			},
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeGroupCommand = {
		type: "node.group",
		pageId: found.page.id,
		childIds,
		groupId: cmd.groupId,
		groupTemplate,
	};
	return { ir: next, inverse };
}

function applyPageCreate(
	ir: CanvasIR,
	cmd: CanvasPageCreateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	if (ir.pages.some((p) => p.id === cmd.page.id)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Page id "${cmd.page.id}" already exists`,
		);
	}
	const insertIndex = cmd.index ?? ir.pages.length;
	if (insertIndex < 0 || insertIndex > ir.pages.length) {
		throw new CanvasCommandError(
			"index-out-of-range",
			`Insert index ${insertIndex} out of range for pages length ${ir.pages.length}`,
		);
	}
	const newPages = [...ir.pages];
	newPages.splice(insertIndex, 0, cmd.page);
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageDeleteCommand = {
		type: "page.delete",
		pageId: cmd.page.id,
	};
	return { ir: next, inverse };
}

function applyPageDelete(
	ir: CanvasIR,
	cmd: CanvasPageDeleteCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	if (idx < 0) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const removed = ir.pages[idx];
	if (!removed) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const newPages = ir.pages.filter((_, i) => i !== idx);
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageCreateCommand = {
		type: "page.create",
		page: removed,
		index: idx,
	};
	return { ir: next, inverse };
}

function applyPageRename(
	ir: CanvasIR,
	cmd: CanvasPageRenameCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	if (idx < 0) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const current = ir.pages[idx];
	if (!current) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const priorName = current.name;
	if (priorName !== cmd.from) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Page "${cmd.pageId}" name "${priorName ?? ""}" does not match expected "from" "${cmd.from ?? ""}"`,
		);
	}
	const renamed: CanvasPage =
		cmd.to === undefined
			? (() => {
					const { name: _omit, ...rest } = current;
					return rest as CanvasPage;
				})()
			: { ...current, name: cmd.to };
	const newPages = ir.pages.map((p, i) => (i === idx ? renamed : p));
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageRenameCommand = {
		type: "page.rename",
		pageId: cmd.pageId,
		from: cmd.to,
		to: priorName,
	};
	return { ir: next, inverse };
}

function applyPageReorder(
	ir: CanvasIR,
	cmd: CanvasPageReorderCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	if (idx < 0) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	if (idx !== cmd.from) {
		throw new CanvasCommandError(
			"index-out-of-range",
			`Page "${cmd.pageId}" is at index ${idx}, not ${cmd.from}`,
		);
	}
	const length = ir.pages.length;
	if (cmd.to < 0 || cmd.to >= length) {
		throw new CanvasCommandError(
			"index-out-of-range",
			`Reorder target index ${cmd.to} out of range for pages length ${length}`,
		);
	}
	const newPages = [...ir.pages];
	const [moved] = newPages.splice(cmd.from, 1);
	if (!moved) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Page splice returned undefined at index ${cmd.from}`,
		);
	}
	newPages.splice(cmd.to, 0, moved);
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageReorderCommand = {
		type: "page.reorder",
		pageId: cmd.pageId,
		from: cmd.to,
		to: cmd.from,
	};
	return { ir: next, inverse };
}

/**
 * Apply a sequence of commands as one reversible unit. Folds `applyCommand`
 * over a local working IR (never touching the caller's `ir`), so a throw from
 * any sub-command leaves the input unchanged — all-or-nothing. The inverse is a
 * `batch` of the sub-inverses in reverse order, replayable through this same
 * `case "batch"` by undo/redo.
 */
function applyBatch(
	ir: CanvasIR,
	cmd: CanvasBatchCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	let working = ir;
	const inverses: CanvasCommand[] = [];
	for (const sub of cmd.commands) {
		const result = applyCommand(working, sub, options);
		working = result.ir;
		inverses.push(result.inverse);
	}
	inverses.reverse();
	const inverse: CanvasBatchCommand = {
		type: "batch",
		...(cmd.label !== undefined ? { label: cmd.label } : {}),
		commands: inverses,
	};
	return { ir: working, inverse };
}

function applyNodeReorder(
	ir: CanvasIR,
	cmd: CanvasNodeReorderCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const parentResult = parentOf(ir, cmd.nodeId);
	if (!parentResult) {
		throw new CanvasCommandError(
			"parent-not-found",
			`Node "${cmd.nodeId}" has no parent (likely a page root)`,
		);
	}
	const parent = parentResult.parent;
	const fromIndex = parent.children.findIndex((c) => c.id === cmd.nodeId);
	if (fromIndex < 0) {
		throw new CanvasCommandError(
			"node-not-found",
			`Node "${cmd.nodeId}" not found under parent "${parent.id}"`,
		);
	}
	const maxIndex = parent.children.length - 1;
	const toIndex = Math.max(0, Math.min(maxIndex, cmd.toIndex));
	let next: CanvasIR;
	try {
		next = reorderChildren(ir, {
			parentId: parent.id,
			fromIndex,
			toIndex,
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeReorderCommand = {
		type: "node.reorder",
		nodeId: cmd.nodeId,
		toIndex: fromIndex,
	};
	return { ir: next, inverse };
}

export function applyCommand(
	ir: CanvasIR,
	cmd: CanvasCommand,
	options: CommandApplyOptions = {},
): CommandApplyResult {
	switch (cmd.type) {
		case "node.create":
			return applyNodeCreate(ir, cmd, options);
		case "node.delete":
			return applyNodeDelete(ir, cmd, options);
		case "node.reorder":
			return applyNodeReorder(ir, cmd, options);
		case "node.move":
			return applyNodeMove(ir, cmd, options);
		case "node.resize":
			return applyNodeResize(ir, cmd, options);
		case "node.rotate":
			return applyNodeRotate(ir, cmd, options);
		case "node.update":
			return applyNodeUpdate(ir, cmd, options);
		case "image.replace":
			return applyImageReplace(ir, cmd, options);
		case "node.group":
			return applyNodeGroup(ir, cmd, options);
		case "node.ungroup":
			return applyNodeUngroup(ir, cmd, options);
		case "page.create":
			return applyPageCreate(ir, cmd, options);
		case "page.delete":
			return applyPageDelete(ir, cmd, options);
		case "page.reorder":
			return applyPageReorder(ir, cmd, options);
		case "page.rename":
			return applyPageRename(ir, cmd, options);
		case "batch":
			return applyBatch(ir, cmd, options);
	}
}
