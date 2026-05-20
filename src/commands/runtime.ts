import {
	CanvasIRMutationError,
	insertNode,
	removeNode,
	updateNode,
} from "../ir-mutations.js";
import { findNode, parentOf } from "../ir-walkers.js";
import type {
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
	CanvasNodeMoveCommand,
	CanvasNodeResizeCommand,
	CanvasNodeRotateCommand,
	CanvasPageCreateCommand,
	CanvasPageDeleteCommand,
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

function expectNode(ir: CanvasIR, id: string): { node: CanvasNode; page: CanvasPage } {
	const found = findNode(ir, id);
	if (!found) {
		throw new CanvasCommandError(
			"node-not-found",
			`Node id "${id}" not found`,
		);
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

function locateSiblingIndex(
	parent: CanvasGroupNode,
	childId: string,
): number {
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
		case "page.create":
			return applyPageCreate(ir, cmd, options);
		case "page.delete":
			return applyPageDelete(ir, cmd, options);
		case "page.reorder":
			return applyPageReorder(ir, cmd, options);
	}
}

