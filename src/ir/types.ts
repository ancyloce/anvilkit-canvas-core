export type CanvasUnit = "px" | "mm" | "in";

export type CanvasBackgroundKind = "solid" | "image" | "gradient";

export type CanvasNodeKind =
	| "group"
	| "frame"
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

export interface CanvasGradientStop {
	/** Position along the gradient, 0..1. */
	offset: number;
	color: string;
}

/**
 * A linear or radial gradient fill. `from`/`to` are normalized (0..1) points in
 * the node's local box, so the gradient scales with the node.
 */
export interface CanvasGradientFill {
	kind: "linear" | "radial";
	stops: CanvasGradientStop[];
	from: { x: number; y: number };
	to: { x: number; y: number };
}

/** A node fill: a plain CSS color string (back-compat) or a structured gradient. */
export type CanvasFill = string | CanvasGradientFill;

export interface CanvasShadow {
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
	opacity?: number;
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

/** What a frame stands in for until real content is dropped into it. */
export type FramePlaceholderKind = "image" | "logo";

/**
 * Marks a frame as an empty slot awaiting content — an image well, a logo well.
 * Deliberately minimal: enough to say "this frame is an image placeholder".
 * Template slot binding is a separate concern and does not live here.
 */
export interface FramePlaceholder {
	kind: FramePlaceholderKind;
	/** Asset currently filling the placeholder, when one has been chosen. */
	assetId?: string;
}

/**
 * A layout container. Unlike a group — which is a pure grouping of siblings and
 * derives its bounds from them — a frame has its own bounds, can clip its
 * children to them, and can paint a background. It is the unit a template stamps
 * content into.
 */
export interface CanvasFrameNode extends CanvasNodeBase {
	type: "frame";
	children: CanvasNode[];
	/** Clip children to the frame's bounds. */
	clip?: boolean;
	background?: CanvasFill;
	placeholder?: FramePlaceholder;
	/** Corner radius, in local units. Matches `CanvasRectNode["radius"]`. */
	radius?: number;
}

/**
 * A node that holds `children` and is therefore recursed into by every walker,
 * mutation, and serializer. Group was the only container until frame landed;
 * anything gated on "does this node have children" must test against this union
 * rather than `type === "group"`.
 */
export type CanvasContainerNode = CanvasGroupNode | CanvasFrameNode;

export interface CanvasRectNode extends CanvasNodeBase {
	type: "rect";
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	radius?: number;
	shadow?: CanvasShadow;
}

export interface CanvasEllipseNode extends CanvasNodeBase {
	type: "ellipse";
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	shadow?: CanvasShadow;
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
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	shadow?: CanvasShadow;
}

export interface CanvasTextNode extends CanvasNodeBase {
	type: "text";
	text: string;
	fontFamily: string;
	fontSize: number;
	fontWeight?: string;
	fill: CanvasFill;
	align?: CanvasTextAlign;
	shadow?: CanvasShadow;
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
	| CanvasFrameNode
	| CanvasRectNode
	| CanvasEllipseNode
	| CanvasLineNode
	| CanvasPathNode
	| CanvasTextNode
	| CanvasImageNode
	| CanvasAiPlaceholderNode;

export type CanvasLeafNode = Exclude<CanvasNode, CanvasContainerNode>;

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

/**
 * Every CanvasIR schema version this build can read. Documents at older
 * versions are forward-migrated on read (`migrateCanvasIR`/`runtime.migrate`);
 * `CanvasIR["version"]` — the version this build writes — is always the
 * newest member.
 */
export type CanvasIRVersion = "1" | "2";

/**
 * What a document is: an editable design (the default when absent), an
 * instance stamped from a template, or a variant produced for export.
 */
export type CanvasDocumentKind =
	| "design"
	| "template-instance"
	| "export-variant";

export interface CanvasIR {
	version: "2";
	documentKind?: CanvasDocumentKind;
	id: string;
	title: string;
	pages: CanvasPage[];
	assets: Record<string, CanvasAssetRef>;
	metadata: CanvasIRMetadata;
}
