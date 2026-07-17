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

/**
 * Per-edge inset distances, in the owning page's `size.unit`. The single
 * shared insets shape (PRD 0012 §9.3) — `CanvasSafeArea` (templates) aliases
 * it, and page layout aids (margin/bleed/safeArea) reuse it.
 */
export interface CanvasInsets {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/**
 * Persistent ruler guides for one page (FR-111): axis-aligned positions in
 * page coordinates (`size.unit`). `horizontal` guides are y-positions,
 * `vertical` guides are x-positions.
 */
export interface CanvasPageGuides {
	horizontal: readonly number[];
	vertical: readonly number[];
}

/**
 * Page-level layout aids (PRD 0012 §9.3 / FR-113): persistent guides plus
 * margin/bleed/safe-area insets. Purely advisory editor chrome — serializers
 * never render these unless a caller explicitly opts in. Absent field =
 * that aid is unset; absent object = no aids at all (so pre-existing
 * documents need no migration).
 */
export interface CanvasPageLayoutAids {
	guides?: CanvasPageGuides;
	margin?: CanvasInsets;
	bleed?: CanvasInsets;
	safeArea?: CanvasInsets;
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

/**
 * Non-destructive image adjustments (C-04, FR-100). All fields optional;
 * absent = neutral. Ranges: `brightness`/`contrast`/`saturation`/`exposure`/
 * `temperature`/`tint` -1..1, `grayscale`/`sepia` 0..1, `blur` 0..100 (page
 * units). Rendering math lives in `ir/image-adjustments.ts` — one color
 * matrix shared by the editor canvas and the SVG serializer.
 */
export interface CanvasImageAdjustments {
	brightness?: number;
	contrast?: number;
	saturation?: number;
	exposure?: number;
	temperature?: number;
	tint?: number;
	blur?: number;
	grayscale?: number;
	sepia?: number;
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

/**
 * Drop shadow as an entry in the extensible effect list (C-03, PRD 0012
 * §9.4/FR-077). Supersedes the legacy per-node `shadow` field — see
 * {@link resolveNodeEffects} for the documented precedence — and adds
 * `spread` over {@link CanvasShadow}.
 */
export interface CanvasDropShadowEffect {
	type: "drop-shadow";
	color: string;
	blur: number;
	offsetX: number;
	offsetY: number;
	/** Outward dilation of the shadow silhouette before blurring, in page units. Default 0. */
	spread?: number;
	opacity?: number;
}

/** Gaussian blur of the node itself (C-03, §9.4). */
export interface CanvasBlurEffect {
	type: "blur";
	/** Blur radius in page units (SVG stdDeviation ≈ radius / 2, matching the shadow-blur convention). */
	radius: number;
}

/**
 * One visual effect on a node (§9.4). Serializable and renderer-independent;
 * the list is ordered (shadows render bottom-up, a trailing blur applies to
 * the composited result).
 */
export type CanvasEffect = CanvasDropShadowEffect | CanvasBlurEffect;

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
	cornerRadii?: CanvasCornerRadii;
}

/**
 * A node that holds `children` and is therefore recursed into by every walker,
 * mutation, and serializer. Group was the only container until frame landed;
 * anything gated on "does this node have children" must test against this union
 * rather than `type === "group"`.
 */
export type CanvasContainerNode = CanvasGroupNode | CanvasFrameNode;

/** FR-075 extended stroke styling (B-03a). All optional — absent = current rendering. */
export type CanvasStrokeCap = "butt" | "round" | "square";
export type CanvasStrokeJoin = "miter" | "round" | "bevel";
/** Line/path end decorations (FR-075). Absent = "none". */
export type CanvasArrowHead = "none" | "arrow";

export interface CanvasStrokeStyle {
	/** Stroke alpha 0..1, independent of node opacity. */
	strokeOpacity?: number;
	/** SVG-style dash array, in local units. Empty/absent = solid. */
	strokeDash?: number[];
	strokeCap?: CanvasStrokeCap;
	strokeJoin?: CanvasStrokeJoin;
}

/**
 * FR-076 per-corner radii (B-03b) for rect/frame. When present it takes
 * precedence over the shared `radius`. Values clamp to half the box size at
 * render time.
 */
export interface CanvasCornerRadii {
	topLeft: number;
	topRight: number;
	bottomRight: number;
	bottomLeft: number;
}

export interface CanvasRectNode extends CanvasNodeBase, CanvasStrokeStyle {
	type: "rect";
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	radius?: number;
	cornerRadii?: CanvasCornerRadii;
	shadow?: CanvasShadow;
	/** Extensible effect list (C-03, §9.4); takes precedence over `shadow` — see {@link resolveNodeEffects}. */
	effects?: CanvasEffect[];
}

export interface CanvasEllipseNode extends CanvasNodeBase, CanvasStrokeStyle {
	type: "ellipse";
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	shadow?: CanvasShadow;
	/** Extensible effect list (C-03, §9.4); takes precedence over `shadow` — see {@link resolveNodeEffects}. */
	effects?: CanvasEffect[];
}

export interface CanvasPolygonNode extends CanvasNodeBase, CanvasStrokeStyle {
	type: "polygon";
	/** Vertex count. Must be an integer >= 3. */
	sides: number;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	shadow?: CanvasShadow;
	/** Extensible effect list (C-03, §9.4); takes precedence over `shadow` — see {@link resolveNodeEffects}. */
	effects?: CanvasEffect[];
}

export interface CanvasStarNode extends CanvasNodeBase, CanvasStrokeStyle {
	type: "star";
	/** Number of outer tips. Must be an integer >= 3. */
	points: number;
	/** Inner-vertex radius as a fraction of the outer radius, 0..1. */
	innerRadiusRatio: number;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	shadow?: CanvasShadow;
	/** Extensible effect list (C-03, §9.4); takes precedence over `shadow` — see {@link resolveNodeEffects}. */
	effects?: CanvasEffect[];
}

export interface CanvasLineNode extends CanvasNodeBase, CanvasStrokeStyle {
	type: "line";
	points: [number, number, number, number];
	stroke: string;
	strokeWidth?: number;
	arrowStart?: CanvasArrowHead;
	arrowEnd?: CanvasArrowHead;
}

export interface CanvasPathNode extends CanvasNodeBase, CanvasStrokeStyle {
	type: "path";
	d: string;
	fill?: CanvasFill;
	stroke?: string;
	strokeWidth?: number;
	arrowStart?: CanvasArrowHead;
	arrowEnd?: CanvasArrowHead;
	shadow?: CanvasShadow;
	/** Extensible effect list (C-03, §9.4); takes precedence over `shadow` — see {@link resolveNodeEffects}. */
	effects?: CanvasEffect[];
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
	/** Extensible effect list (C-03, §9.4); takes precedence over `shadow` — see {@link resolveNodeEffects}. */
	effects?: CanvasEffect[];
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
	/** FR-081 (B-03c). */
	strikethrough?: boolean;
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
	/**
	 * FR-081 sizing mode (B-03c): `auto-width` lets the measured content decide
	 * the box width (the editor keeps `width` synced to the measurement);
	 * absent/`fixed` keeps the explicit `width` authoritative.
	 */
	sizing?: "fixed" | "auto-width";
	/** The wrap width, in local units. */
	width: number;
	/** Fixed height. Omit to let the measured content decide (`auto-height`). */
	height?: number;
	paragraphs: RichTextParagraph[];
	overflow?: RichTextOverflow;
	wrap?: RichTextWrap;
	/**
	 * FR-081 vertical alignment of the laid-out text block within `bounds`
	 * (PRD 0012 §7.9). `top` (default when absent) aligns to the top edge;
	 * `middle` centers; `bottom` aligns to the bottom edge. Applies only when
	 * the box is taller than its content — i.e. with an explicit `height` or
	 * `bounds.height` larger than the measured text height.
	 */
	verticalAlign?: CanvasVerticalAlign;
}

/** FR-081 vertical text alignment within a fixed-height box. */
export type CanvasVerticalAlign = "top" | "middle" | "bottom";

/**
 * FR-094 image fit modes (B-02, PRD 0012 §9.5). Absent means `"stretch"` —
 * the pre-B-02 rendering — so existing documents need no migration.
 */
export type CanvasImageFitMode =
	| "fill"
	| "fit"
	| "stretch"
	| "original"
	| "center";

export interface CanvasImageNode extends CanvasNodeBase {
	type: "image";
	assetId: string;
	/**
	 * How the bitmap maps into `bounds` (FR-094): `stretch` distorts to fill
	 * (default), `fill` covers with cropping, `fit` letterboxes, `original`
	 * places the bitmap at its intrinsic size from the node origin, `center`
	 * centers it — both clipped to the bounds. `crop` applies within the
	 * fitted image space.
	 */
	fitMode?: CanvasImageFitMode;
	crop?: CanvasImageCrop;
	filters?: ImageFilter[];
	/**
	 * Non-destructive image adjustments (C-04, FR-100). Unlike the open-ended
	 * `filters` stub, these have a defined vocabulary, defined ranges, and a
	 * defined rendering in both the editor and the SVG serializer (one shared
	 * color matrix — see `ir/image-adjustments.ts`). The source asset is
	 * never modified.
	 */
	adjustments?: CanvasImageAdjustments;
	maskAssetId?: string;
	/**
	 * Live binding to a brand-kit asset/logo token, when this image should track
	 * a token rather than (or alongside) a fixed `assetId`. Resolution is
	 * external to core.
	 */
	assetToken?: BrandTokenRef;
	/**
	 * Accessible alternative text (§12 item 11). Emitted by the SVG serializer
	 * as the `<image>`'s `<title>` + `aria-label`; surfaced by the editor's
	 * accessibility scene tree. Optional and additive.
	 */
	alt?: string;
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
	/** Accessible alternative text (§12 item 11). See {@link CanvasImageNode.alt}. */
	alt?: string;
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
	/** Persistent guides + margin/bleed/safe-area (PRD 0012 §9.3, C-01). See {@link CanvasPageLayoutAids}. */
	layoutAids?: CanvasPageLayoutAids;
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
