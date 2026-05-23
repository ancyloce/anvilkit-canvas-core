import {
	CanvasIRMutationError,
	insertNode,
	removeNode,
	updateNode,
} from "../ir-mutations.js";
import { findNode, parentOf } from "../ir-walkers.js";
import type {
	CanvasBounds,
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
} from "../types.js";
import type {
	CanvasAnyNodeUpdateCommand,
	CanvasCommand,
	CanvasImageReplaceCommand,
	CanvasNodeCreateCommand,
	CanvasNodeDeleteCommand,
	CanvasNodeGroupCommand,
	CanvasNodeMoveCommand,
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

function nowIso(): string {
	return new Date().toISOString();
}

function bumpMetadata(ir: CanvasIR, options: CommandApplyOptions): CanvasIR {
	const now = options.now ?? nowIso;
	return { ...ir, metadata: { ...ir.metadata, updatedAt: now() } };
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
			case "cannot-remove-page-root":
			case "cannot-move-page-root":
				throw new CanvasCommandError("parent-not-found", err.message);
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
	let maxRight = 0;
	let maxBottom = 0;
	for (const child of children) {
		maxRight = Math.max(maxRight, child.transform.x + child.bounds.width);
		maxBottom = Math.max(maxBottom, child.transform.y + child.bounds.height);
	}
	return { width: maxRight, height: maxBottom };
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
	let next = ir;
	try {
		for (const id of cmd.childIds) {
			next = removeNode(next, { id, now: options.now });
		}
		next = insertNode(next, {
			parentId,
			node: groupNode,
			index: minIndex,
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
	let next = ir;
	try {
		next = removeNode(next, { id: cmd.groupId, now: options.now });
		if (cmd.restore && cmd.restore.length > 0) {
			const plan = [...cmd.restore].sort((a, b) => a.index - b.index);
			for (const { id, index } of plan) {
				const child = children.find((c) => c.id === id);
				if (!child) {
					throw new CanvasCommandError(
						"invariant-violated",
						`Restore id "${id}" is not a child of group "${cmd.groupId}"`,
					);
				}
				next = insertNode(next, {
					parentId,
					node: child,
					index,
					now: options.now,
				});
			}
		} else {
			let index = groupIndex;
			for (const child of children) {
				next = insertNode(next, {
					parentId,
					node: child,
					index,
					now: options.now,
				});
				index += 1;
			}
		}
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
	}
}
