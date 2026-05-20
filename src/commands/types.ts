import type {
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

export type CanvasCommand =
	| CanvasNodeCreateCommand
	| CanvasNodeMoveCommand
	| CanvasNodeResizeCommand
	| CanvasNodeRotateCommand
	| CanvasNodeDeleteCommand
	| CanvasAnyNodeUpdateCommand
	| CanvasImageReplaceCommand
	| CanvasPageCreateCommand
	| CanvasPageReorderCommand
	| CanvasPageDeleteCommand;

export type CanvasCommandKind = CanvasCommand["type"];

export interface CommandApplyResult {
	ir: CanvasIR;
	inverse: CanvasCommand;
}

export interface CommandApplyOptions {
	now?: () => string;
}
