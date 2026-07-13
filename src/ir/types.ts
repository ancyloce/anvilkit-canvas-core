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
	| "svg"
	| "ai-placeholder"
	| "video"
	| "audio";

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

export type CanvasAnimationEasing =
	| "linear"
	| "ease-in"
	| "ease-out"
	| "ease-in-out";

export type CanvasAnimationDirection = "up" | "down" | "left" | "right";

/**
 * Serializable animation metadata (FR-080, canvas-m6-001). Describes intent
 * only — timing/kind data for a future editor preview or video/GIF export
 * worker to interpret. Static exports (SVG/PNG/PDF) always render a node/page
 * in its normal resting state (its own `transform`/`opacity`/etc., unaffected
 * by this field) and merely surface a warning that motion exists but isn't
 * represented — this metadata is never a second, divergent static appearance.
 */
export interface CanvasAnimationBase {
	/** Seconds after the page/timeline starts before this animation begins. Defaults to 0. */
	delay?: number;
	/** Seconds the animation takes to complete. */
	duration: number;
	easing?: CanvasAnimationEasing;
}

export interface CanvasFadeAnimation extends CanvasAnimationBase {
	kind: "fade";
	/** Opacity animates from this value up to the node's own static `opacity`. Defaults to 0. */
	from?: number;
}

export interface CanvasSlideAnimation extends CanvasAnimationBase {
	kind: "slide";
	direction: CanvasAnimationDirection;
	/** Distance travelled, in the node's coordinate unit. Defaults to the node's own size along that axis. */
	distance?: number;
}

export interface CanvasScaleAnimation extends CanvasAnimationBase {
	kind: "scale";
	/** Scale factor animates from this value up to the node's own static scale. Defaults to 0. */
	from?: number;
}

export interface CanvasRotateAnimation extends CanvasAnimationBase {
	kind: "rotate";
	/** Degrees animates from this value up to the node's own static rotation. */
	from?: number;
}

export interface CanvasPopAnimation extends CanvasAnimationBase {
	kind: "pop";
	/** Overshoot scale factor before settling at the node's own static scale (e.g. 1.1 = 10% overshoot). */
	overshoot?: number;
}

export interface CanvasTypewriterAnimation extends CanvasAnimationBase {
	kind: "typewriter";
	/** Characters revealed per second. */
	charsPerSecond?: number;
}

export interface CanvasMotionPathAnimation extends CanvasAnimationBase {
	kind: "motion-path";
	/** SVG path data (`d` attribute syntax) the node's origin travels along. */
	path: string;
}

export type CanvasAnimation =
	| CanvasFadeAnimation
	| CanvasSlideAnimation
	| CanvasScaleAnimation
	| CanvasRotateAnimation
	| CanvasPopAnimation
	| CanvasTypewriterAnimation
	| CanvasMotionPathAnimation;

export interface CanvasNodeMeta {
	aiSource?: CanvasAiSourceMeta;
	animation?: CanvasAnimation;
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

/**
 * An asset-referencing SVG node (FR-016). Deliberately holds ONLY an
 * `assetId` — raw SVG markup never enters Canvas IR. `canvas-core` performs
 * no SVG parsing or sanitization; that is an ingest-time host responsibility
 * (see the threat-model doc referenced from this task). Serializers render
 * it via the same safe `<image>` asset-reference path `image` nodes use,
 * with a structured `SVG_INLINE_UNSUPPORTED` warning — true inline vector
 * embedding is deferred behind a future `inlineVectorSvg` capability flag.
 */
export interface CanvasSvgNode extends CanvasNodeBase {
	type: "svg";
	assetId: string;
}

export interface CanvasAiPlaceholderNode extends CanvasNodeBase {
	type: "ai-placeholder";
	jobId: string;
	status: CanvasAiPlaceholderStatus;
	sourcePrompt?: string;
}

/** A playback trim window, in seconds into the source media (FR-081, canvas-m6-002). */
export interface CanvasMediaTrim {
	/** Seconds into the source media to start playback. Defaults to 0. */
	start?: number;
	/** Seconds into the source media to stop playback. Defaults to the source's natural end. */
	end?: number;
}

/**
 * Fields shared by the video/audio asset-reference nodes (FR-081,
 * canvas-m6-002). Deliberately holds ONLY an `assetId` — no inline media
 * bytes ever enter Canvas IR, matching the `image`/`svg` asset-reference
 * convention. No playback/rendering is implemented in canvas-core: this is a
 * contract an export/render worker consumes later.
 */
export interface CanvasMediaNodeBase extends CanvasNodeBase {
	assetId: string;
	trim?: CanvasMediaTrim;
	muted?: boolean;
	/** 0-1 playback volume. Defaults to 1 (full volume). Ignored when `muted`. */
	volume?: number;
}

export interface CanvasVideoNode extends CanvasMediaNodeBase {
	type: "video";
	/** Asset id of a still frame — the only visual a static export can show for a video node. */
	poster?: string;
}

export interface CanvasAudioNode extends CanvasMediaNodeBase {
	type: "audio";
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
	| CanvasSvgNode
	| CanvasAiPlaceholderNode
	| CanvasVideoNode
	| CanvasAudioNode;

export type CanvasLeafNode = Exclude<CanvasNode, CanvasContainerNode>;

export type CanvasNodeByKind<K extends CanvasNodeKind> = Extract<
	CanvasNode,
	{ type: K }
>;

/**
 * Traceback metadata stamped onto a page generated by {@link resizeToVariants}
 * (FR-061, canvas-m3-007) — absent on every other page. `presetId`/
 * `presetVersion` pin the exact catalog entry (`CANVAS_SIZE_PRESETS`) the page
 * was sized from, since a preset's dimensions can change under a later
 * `version` while this page keeps whatever size it had at generation time.
 */
export interface CanvasPageVariantSource {
	sourcePageId: string;
	presetId: string;
	presetVersion: string;
}

export interface CanvasPage {
	id: string;
	name?: string;
	size: CanvasPageSize;
	background: CanvasPageBackground;
	root: CanvasGroupNode;
	/** Set only on a page generated by campaign resize (FR-061); see {@link CanvasPageVariantSource}. */
	variantSource?: CanvasPageVariantSource;
	/** Page-level enter/exit animation (FR-080, canvas-m6-001) — e.g. a whole-page fade for a slideshow/motion export. See {@link CanvasAnimation}. */
	animation?: CanvasAnimation;
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
