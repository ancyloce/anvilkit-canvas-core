import type {
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
} from "../types.js";

export interface CanvasPoint {
	x: number;
	y: number;
}

export interface CanvasRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CanvasNodeCreateCommand {
	type: "node.create";
	node: CanvasNode;
	pageId: string;
	parentId?: string;
	index?: number;
}

export interface CanvasNodeMoveCommand {
	type: "node.move";
	nodeId: string;
	from: CanvasPoint;
	to: CanvasPoint;
}

export interface CanvasNodeResizeCommand {
	type: "node.resize";
	nodeId: string;
	from: CanvasRect;
	to: CanvasRect;
}

export interface CanvasNodeRotateCommand {
	type: "node.rotate";
	nodeId: string;
	from: number;
	to: number;
}

export interface CanvasNodeDeleteCommand {
	type: "node.delete";
	nodeId: string;
}

export interface CanvasNodeUpdateCommand<K extends CanvasNodeKind> {
	type: "node.update";
	nodeId: string;
	kind: K;
	patch: Partial<Omit<CanvasNodeByKind<K>, "id" | "type">>;
}

export type CanvasAnyNodeUpdateCommand = {
	[K in CanvasNodeKind]: CanvasNodeUpdateCommand<K>;
}[CanvasNodeKind];

export interface CanvasImageReplaceCommand {
	type: "image.replace";
	nodeId: string;
	fromAssetId: string;
	toAssetId: string;
}

/**
 * Wrap one or more sibling nodes in a new group node. All `childIds` must share
 * the same immediate parent group on `pageId`; they are wrapped in their current
 * sibling z-order and the new group takes the slot of the topmost selected node.
 * No child transforms are altered (the group is created with an identity
 * transform), so grouping is visually a no-op and exactly reversible.
 */
export interface CanvasNodeGroupCommand {
	type: "node.group";
	pageId: string;
	childIds: string[];
	groupId: string;
	groupName?: string;
	/**
	 * When present (e.g. as the inverse of `node.ungroup`), the created group is
	 * reconstructed verbatim from these fields rather than as a canonical identity
	 * group. `children` are always supplied from `childIds`.
	 */
	groupTemplate?: Omit<CanvasGroupNode, "children">;
}

/**
 * Dissolve a group, lifting its children into the group's parent. By default the
 * children spill out contiguously at the group's former slot. When `restore` is
 * present (as produced by the inverse of `node.group`), each child is instead
 * placed back at its recorded original index so the prior tree is reconstructed
 * exactly even for non-contiguous selections.
 */
export interface CanvasNodeUngroupCommand {
	type: "node.ungroup";
	groupId: string;
	restore?: Array<{ id: string; index: number }>;
}

export interface CanvasPageCreateCommand {
	type: "page.create";
	page: CanvasPage;
	index?: number;
}

export interface CanvasPageReorderCommand {
	type: "page.reorder";
	pageId: string;
	from: number;
	to: number;
}

export interface CanvasPageDeleteCommand {
	type: "page.delete";
	pageId: string;
}

export interface CanvasPageRenameCommand {
	type: "page.rename";
	pageId: string;
	from: string | undefined;
	to: string | undefined;
}

export type CanvasCommand =
	| CanvasNodeCreateCommand
	| CanvasNodeMoveCommand
	| CanvasNodeResizeCommand
	| CanvasNodeRotateCommand
	| CanvasNodeDeleteCommand
	| CanvasAnyNodeUpdateCommand
	| CanvasImageReplaceCommand
	| CanvasNodeGroupCommand
	| CanvasNodeUngroupCommand
	| CanvasPageCreateCommand
	| CanvasPageReorderCommand
	| CanvasPageRenameCommand
	| CanvasPageDeleteCommand;

export type CanvasCommandKind = CanvasCommand["type"];

export interface CommandApplyResult {
	ir: CanvasIR;
	inverse: CanvasCommand;
}

export interface CommandApplyOptions {
	now?: () => string;
}
