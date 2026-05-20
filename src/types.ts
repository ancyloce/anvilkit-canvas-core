export type CanvasUnit = "px" | "mm" | "in";

export type CanvasBackgroundKind = "solid" | "image" | "gradient";

export type CanvasNodeKind =
	| "group"
	| "rect"
	| "ellipse"
	| "line"
	| "path"
	| "text"
	| "image"
	| "ai-placeholder";

export type CanvasTextAlign = "left" | "center" | "right";

export type CanvasAiPlaceholderStatus = "pending" | "complete" | "error";

export interface CanvasTransform {
	x: number;
	y: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	skewX?: number;
	skewY?: number;
}

export interface CanvasBounds {
	width: number;
	height: number;
}

export interface CanvasPageSize {
	width: number;
	height: number;
	unit: CanvasUnit;
	dpi?: number;
}

export interface CanvasPageBackground {
	kind: CanvasBackgroundKind;
	value: string;
}

export interface CanvasAssetRef {
	id: string;
	uri: string;
	mimeType?: string;
	width?: number;
	height?: number;
	byteSize?: number;
}

export interface CanvasImageCrop {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface ImageFilter {
	kind: string;
	params?: Record<string, number | string | boolean>;
}

export interface CanvasIRMetadata {
	createdAt: string;
	updatedAt: string;
	ownerId?: string;
	brandId?: string;
}

export interface CanvasAiSourceMeta {
	prompt?: string;
	model?: string;
	ts: number;
}

export interface CanvasNodeMeta {
	aiSource?: CanvasAiSourceMeta;
}

export interface CanvasNodeBase {
	id: string;
	name?: string;
	transform: CanvasTransform;
	bounds: CanvasBounds;
	opacity?: number;
	visible?: boolean;
	locked?: boolean;
	blendMode?: string;
	zIndex: number;
	meta?: CanvasNodeMeta;
}

export interface CanvasGroupNode extends CanvasNodeBase {
	type: "group";
	children: CanvasNode[];
}

export interface CanvasRectNode extends CanvasNodeBase {
	type: "rect";
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
	radius?: number;
}

export interface CanvasEllipseNode extends CanvasNodeBase {
	type: "ellipse";
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
}

export interface CanvasLineNode extends CanvasNodeBase {
	type: "line";
	points: [number, number, number, number];
	stroke: string;
	strokeWidth?: number;
}

export interface CanvasPathNode extends CanvasNodeBase {
	type: "path";
	d: string;
	fill?: string;
	stroke?: string;
	strokeWidth?: number;
}

export interface CanvasTextNode extends CanvasNodeBase {
	type: "text";
	text: string;
	fontFamily: string;
	fontSize: number;
	fontWeight?: string;
	fill: string;
	align?: CanvasTextAlign;
}

export interface CanvasImageNode extends CanvasNodeBase {
	type: "image";
	assetId: string;
	crop?: CanvasImageCrop;
	filters?: ImageFilter[];
	maskAssetId?: string;
}

export interface CanvasAiPlaceholderNode extends CanvasNodeBase {
	type: "ai-placeholder";
	jobId: string;
	status: CanvasAiPlaceholderStatus;
	sourcePrompt?: string;
}

export type CanvasNode =
	| CanvasGroupNode
	| CanvasRectNode
	| CanvasEllipseNode
	| CanvasLineNode
	| CanvasPathNode
	| CanvasTextNode
	| CanvasImageNode
	| CanvasAiPlaceholderNode;

export type CanvasLeafNode = Exclude<CanvasNode, CanvasGroupNode>;

export type CanvasNodeByKind<K extends CanvasNodeKind> = Extract<
	CanvasNode,
	{ type: K }
>;

export interface CanvasPage {
	id: string;
	name?: string;
	size: CanvasPageSize;
	background: CanvasPageBackground;
	root: CanvasGroupNode;
}

export interface CanvasIR {
	version: "1";
	id: string;
	title: string;
	pages: CanvasPage[];
	assets: Record<string, CanvasAssetRef>;
	metadata: CanvasIRMetadata;
}
