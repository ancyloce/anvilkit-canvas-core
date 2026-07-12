export type CanvasUnit = "px" | "mm" | "in";

export type CanvasBackgroundKind = "solid" | "image" | "gradient";

export type CanvasNodeKind =
	| "group"
	| "frame"
	| "rect"
	| "ellipse"
	| "polygon"
	| "star"
	| "line"
	| "path"
	| "text"
	| "rich-text"
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

export type BrandTokenType = "color" | "font" | "spacing" | "asset" | "logo";

/**
 * A reference to a value owned by an external brand kit (PRD §12.4) — a
 * color, font, spacing value, asset, or logo — identified by `id` alone.
 * Resolution is deliberately EXTERNAL to core: this is just the SHAPE of a
 * reference, never a lookup table or a brand-kit type. A consumer (the SVG
 * serializer's `resolveBrandToken` option, or a future editor equivalent)
 * turns it into a concrete value; core never resolves one itself.
 */
export interface BrandTokenRef {
	type: "brand-token";
	tokenType: BrandTokenType;
	id: string;
}

/**
 * A node fill: a plain CSS color string (back-compat), a structured gradient,
 * or a brand-token reference (unresolved until a consumer looks it up).
 */
export type CanvasFill = string | CanvasGradientFill | BrandTokenRef;

/** A font family: a literal name, or a brand-token reference to one. */
export type CanvasFontFamily = string | BrandTokenRef;

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
	/**
	 * Live binding to a brand-kit asset/logo token, when this placeholder should
	 * track a token rather than (or alongside) a fixed `assetId`. Resolution is
	 * external to core.
	 */
	assetToken?: BrandTokenRef;
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

export interface CanvasPolygonNode extends CanvasNodeBase {
	type: "polygon";
	/** Vertex count. Must be an integer >= 3. */
	sides: number;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	shadow?: CanvasShadow;
}

export interface CanvasStarNode extends CanvasNodeBase {
	type: "star";
	/** Number of outer tips. Must be an integer >= 3. */
	points: number;
	/** Inner-vertex radius as a fraction of the outer radius, 0..1. */
	innerRadiusRatio: number;
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
	fontFamily: CanvasFontFamily;
	fontSize: number;
	fontWeight?: string;
	fill: CanvasFill;
	align?: CanvasTextAlign;
	shadow?: CanvasShadow;
}

/** How a rich-text block behaves when its content exceeds its box. */
export type RichTextOverflow = "visible" | "clip" | "auto-height" | "ellipsis";

/** Where lines may break. `"none"` lays every paragraph out on a single line. */
export type RichTextWrap = "none" | "word" | "character";

/** How a span's glyphs are cased at render time. Purely presentational — the
 * span's `text` is never rewritten, so the original casing survives a round-trip. */
export type RichTextTransform =
	| "none"
	| "uppercase"
	| "lowercase"
	| "capitalize";

/**
 * A styled run of text. Every style field is optional: an omitted field inherits
 * from the host's defaults at measure/render time rather than being resolved
 * here, which keeps the IR free of any font or layout knowledge.
 */
export interface RichTextSpan {
	text: string;
	fontFamily?: CanvasFontFamily;
	fontSize?: number;
	fontWeight?: string;
	italic?: boolean;
	underline?: boolean;
	letterSpacing?: number;
	textTransform?: RichTextTransform;
	fill?: CanvasFill;
}

/** A paragraph: a horizontal run of spans separated from its siblings by a break. */
export interface RichTextParagraph {
	align?: CanvasTextAlign;
	/** Multiple of the resolved font size (1.4 = 140%), not an absolute length. */
	lineHeight?: number;
	spans: RichTextSpan[];
}

/**
 * Multi-span, multi-paragraph text with real wrapping.
 *
 * Deliberately a SEPARATE kind from {@link CanvasTextNode} rather than an
 * extension of it (FR-013): `text` is a single plain string with one style, and
 * its schema, tests and SVG goldens must keep working byte-for-byte.
 *
 * `width` (and optional `height`) are the authoring intent — the box the text is
 * laid out INTO, and the width paragraphs wrap against. `bounds`, inherited from
 * {@link CanvasNodeBase}, remains the node's geometric box: what hit-testing,
 * snapping and group extents read. The two are related but not the same thing,
 * and a host reconciles them after measuring (with `overflow: "auto-height"`,
 * `bounds.height` grows to the measured height while `height` stays unset).
 * Core does not reconcile them, because core cannot measure text — see
 * {@link CanvasTextMeasurer}. This mirrors how `line` carries `points` and `path`
 * carries `d` alongside their bounds.
 */
export interface CanvasRichTextNode extends CanvasNodeBase {
	type: "rich-text";
	/** The wrap width, in local units. */
	width: number;
	/** Fixed height. Omit to let the measured content decide (`auto-height`). */
	height?: number;
	paragraphs: RichTextParagraph[];
	overflow?: RichTextOverflow;
	wrap?: RichTextWrap;
}

export interface CanvasImageNode extends CanvasNodeBase {
	type: "image";
	assetId: string;
	crop?: CanvasImageCrop;
	filters?: ImageFilter[];
	maskAssetId?: string;
	/**
	 * Live binding to a brand-kit asset/logo token, when this image should track
	 * a token rather than (or alongside) a fixed `assetId`. Resolution is
	 * external to core.
	 */
	assetToken?: BrandTokenRef;
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
	| CanvasPolygonNode
	| CanvasStarNode
	| CanvasLineNode
	| CanvasPathNode
	| CanvasTextNode
	| CanvasRichTextNode
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
