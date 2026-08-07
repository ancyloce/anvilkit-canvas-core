import { z } from "zod";
import {
	MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT,
	MAX_COMPONENT_OVERRIDES_PER_INSTANCE,
	MAX_COMPONENT_PROPERTIES_PER_COMPONENT,
	MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE,
	MAX_COMPONENT_RICH_SPANS_PER_PARAGRAPH,
	MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION,
	MAX_COMPONENT_TEXT_OVERRIDE_CHARS,
	MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT,
	MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT,
	MAX_FINITE_LAYOUT_MAGNITUDE,
} from "../limits.js";
import { CanvasBrandComponentPolicySchema } from "./component-policy.js";
import {
	CanvasIRComponentSourceRefSchema,
	CanvasIRExternalComponentRefSchema,
} from "./component-source.js";
import { CanvasComponentVariantSetSchema } from "./component-variants.js";
import { createMigrationRegistry } from "./migrations.js";
import { isSnapshotKey, snapshotKey } from "./snapshot-key.js";
import type {
	BrandTokenRef,
	CanvasAnimation,
	CanvasAssetRef,
	CanvasAutoLayout,
	CanvasBounds,
	CanvasComponentOverride,
	CanvasComponentProperty,
	CanvasComponentRegistry,
	CanvasDocumentCompatibility,
	CanvasDocumentKind,
	CanvasEffect,
	CanvasExternalComponentSnapshotRegistry,
	CanvasFill,
	CanvasFontFamily,
	CanvasFrameShape,
	CanvasGradientFill,
	CanvasGradientStop,
	CanvasGroupNode,
	CanvasImageAdjustments,
	CanvasImageCrop,
	CanvasInsets,
	CanvasIR,
	CanvasIRMetadata,
	CanvasLayoutItem,
	CanvasLayoutMaterialization,
	CanvasMediaTrim,
	CanvasNode,
	CanvasNodeBase,
	CanvasNodeMeta,
	CanvasPage,
	CanvasPageBackground,
	CanvasPageGuides,
	CanvasPageLayoutAids,
	CanvasPageSize,
	CanvasPageVariantSource,
	CanvasShadow,
	CanvasTextOverrideValue,
	CanvasTransform,
	FramePlaceholder,
	ImageFilter,
} from "./types.js";

/**
 * Object schemas use `z.looseObject` (preserve unknown keys) rather than the
 * Zod default (`strip`, which silently drops them). The Canvas IR is a versioned
 * persisted + collaborative wire format, so a replica on an
 * older build must round-trip a newer peer's extra fields instead of silently
 * deleting them — silent stripping would lose data and break CRDT convergence.
 * A stricter trust-boundary posture (`z.strictObject`, reject unknown keys) was
 * considered; `loose` was chosen because it is non-breaking and forward-compatible
 * across a mixed-version swarm, and preserved unknown keys are inert (consumers
 * read only known fields). See `@anvilkit/canvas-editor`'s `decodeCanvasIR`.
 */

const FiniteNumber = z.number().refine((v) => Number.isFinite(v), {
	message: "must be a finite number",
});

const NonNegativeFiniteNumber = FiniteNumber.refine((v) => v >= 0, {
	message: "must be >= 0",
});

/** Shared floor for polygon `sides` and star `points` (FR-014). */
const IntegerAtLeastThree = FiniteNumber.refine(
	(v) => Number.isInteger(v) && v >= 3,
	{ message: "must be an integer >= 3" },
);

/** Star `innerRadiusRatio`: a fraction of the outer radius. */
const UnitInterval = FiniteNumber.refine((v) => v >= 0 && v <= 1, {
	message: "must be between 0 and 1",
});

export const CanvasTransformSchema: z.ZodType<CanvasTransform> = z.looseObject({
	x: FiniteNumber,
	y: FiniteNumber,
	rotation: FiniteNumber,
	scaleX: FiniteNumber,
	scaleY: FiniteNumber,
	skewX: FiniteNumber.optional(),
	skewY: FiniteNumber.optional(),
});

export const CanvasBoundsSchema: z.ZodType<CanvasBounds> = z.looseObject({
	width: NonNegativeFiniteNumber,
	height: NonNegativeFiniteNumber,
});

export const CanvasPageSizeSchema: z.ZodType<CanvasPageSize> = z.looseObject({
	width: NonNegativeFiniteNumber,
	height: NonNegativeFiniteNumber,
	unit: z.enum(["px", "mm", "in"]),
	dpi: FiniteNumber.optional(),
});

export const CanvasPageBackgroundSchema: z.ZodType<CanvasPageBackground> =
	z.looseObject({
		kind: z.enum(["solid", "image", "gradient"]),
		value: z.string(),
	});

export const CanvasInsetsSchema: z.ZodType<CanvasInsets> = z.looseObject({
	top: FiniteNumber,
	right: FiniteNumber,
	bottom: FiniteNumber,
	left: FiniteNumber,
});

export const CanvasPageGuidesSchema: z.ZodType<CanvasPageGuides> =
	z.looseObject({
		horizontal: z.array(FiniteNumber),
		vertical: z.array(FiniteNumber),
	});

export const CanvasPageLayoutAidsSchema: z.ZodType<CanvasPageLayoutAids> =
	z.looseObject({
		guides: CanvasPageGuidesSchema.optional(),
		margin: CanvasInsetsSchema.optional(),
		bleed: CanvasInsetsSchema.optional(),
		safeArea: CanvasInsetsSchema.optional(),
	});

export const CanvasAssetRefSchema: z.ZodType<CanvasAssetRef> = z.looseObject({
	id: z.string().min(1),
	uri: z.string().min(1),
	mimeType: z.string().optional(),
	width: NonNegativeFiniteNumber.optional(),
	height: NonNegativeFiniteNumber.optional(),
	byteSize: NonNegativeFiniteNumber.optional(),
});

export const CanvasImageCropSchema: z.ZodType<CanvasImageCrop> = z.looseObject({
	x: FiniteNumber,
	y: FiniteNumber,
	width: NonNegativeFiniteNumber,
	height: NonNegativeFiniteNumber,
});

export const ImageFilterSchema: z.ZodType<ImageFilter> = z.looseObject({
	kind: z.string().min(1),
	params: z
		.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
		.optional(),
});

/** -1..1 (C-04 adjustment range). */
const SignedUnit = FiniteNumber.refine((v) => v >= -1 && v <= 1, {
	message: "must be between -1 and 1",
});

export const CanvasImageAdjustmentsSchema: z.ZodType<CanvasImageAdjustments> =
	z.looseObject({
		brightness: SignedUnit.optional(),
		contrast: SignedUnit.optional(),
		saturation: SignedUnit.optional(),
		exposure: SignedUnit.optional(),
		temperature: SignedUnit.optional(),
		tint: SignedUnit.optional(),
		blur: NonNegativeFiniteNumber.refine((v) => v <= 100, {
			message: "must be <= 100",
		}).optional(),
		grayscale: UnitInterval.optional(),
		sepia: UnitInterval.optional(),
	});

const CanvasAiSourceMetaSchema = z.looseObject({
	prompt: z.string().optional(),
	model: z.string().optional(),
	ts: FiniteNumber,
});

const CanvasAnimationEasingSchema = z.enum([
	"linear",
	"ease-in",
	"ease-out",
	"ease-in-out",
]);

const CanvasAnimationDirectionSchema = z.enum(["up", "down", "left", "right"]);

const CanvasAnimationBaseShape = {
	delay: NonNegativeFiniteNumber.optional(),
	duration: NonNegativeFiniteNumber,
	easing: CanvasAnimationEasingSchema.optional(),
} as const;

const CanvasFadeAnimationSchema = z.looseObject({
	...CanvasAnimationBaseShape,
	kind: z.literal("fade"),
	from: FiniteNumber.optional(),
});

const CanvasSlideAnimationSchema = z.looseObject({
	...CanvasAnimationBaseShape,
	kind: z.literal("slide"),
	direction: CanvasAnimationDirectionSchema,
	distance: FiniteNumber.optional(),
});

const CanvasScaleAnimationSchema = z.looseObject({
	...CanvasAnimationBaseShape,
	kind: z.literal("scale"),
	from: FiniteNumber.optional(),
});

const CanvasRotateAnimationSchema = z.looseObject({
	...CanvasAnimationBaseShape,
	kind: z.literal("rotate"),
	from: FiniteNumber.optional(),
});

const CanvasPopAnimationSchema = z.looseObject({
	...CanvasAnimationBaseShape,
	kind: z.literal("pop"),
	overshoot: FiniteNumber.optional(),
});

const CanvasTypewriterAnimationSchema = z.looseObject({
	...CanvasAnimationBaseShape,
	kind: z.literal("typewriter"),
	charsPerSecond: NonNegativeFiniteNumber.optional(),
});

const CanvasMotionPathAnimationSchema = z.looseObject({
	...CanvasAnimationBaseShape,
	kind: z.literal("motion-path"),
	path: z.string().min(1),
});

/** A discriminated union over the seven animation kinds (FR-080), dispatched on `kind`. */
export const CanvasAnimationSchema: z.ZodType<CanvasAnimation> =
	z.discriminatedUnion("kind", [
		CanvasFadeAnimationSchema,
		CanvasSlideAnimationSchema,
		CanvasScaleAnimationSchema,
		CanvasRotateAnimationSchema,
		CanvasPopAnimationSchema,
		CanvasTypewriterAnimationSchema,
		CanvasMotionPathAnimationSchema,
	]);

export const CanvasNodeMetaSchema: z.ZodType<CanvasNodeMeta> = z.looseObject({
	aiSource: CanvasAiSourceMetaSchema.optional(),
	animation: CanvasAnimationSchema.optional(),
});

export const CanvasGradientStopSchema: z.ZodType<CanvasGradientStop> =
	z.looseObject({ offset: FiniteNumber, color: z.string() });

export const CanvasGradientFillSchema: z.ZodType<CanvasGradientFill> =
	z.looseObject({
		kind: z.enum(["linear", "radial"]),
		stops: z.array(CanvasGradientStopSchema),
		from: z.looseObject({ x: FiniteNumber, y: FiniteNumber }),
		to: z.looseObject({ x: FiniteNumber, y: FiniteNumber }),
	});

/** Values a `BrandTokenRef` may point at (PRD §12.4). */
const BRAND_TOKEN_TYPES = [
	"color",
	"font",
	"spacing",
	"asset",
	"logo",
] as const;

export const BrandTokenRefSchema: z.ZodType<BrandTokenRef> = z.looseObject({
	type: z.literal("brand-token"),
	tokenType: z.enum(BRAND_TOKEN_TYPES),
	id: z.string().min(1),
});

/**
 * A fill is a plain color string (back-compat), a structured gradient, or an
 * unresolved brand-token reference.
 */
export const CanvasFillSchema: z.ZodType<CanvasFill> = z.union([
	z.string(),
	CanvasGradientFillSchema,
	BrandTokenRefSchema,
]);

/** A font family is a literal name, or a brand-token reference to one. */
export const CanvasFontFamilySchema: z.ZodType<CanvasFontFamily> = z.union([
	z.string().min(1),
	BrandTokenRefSchema,
]);

export const CanvasShadowSchema: z.ZodType<CanvasShadow> = z.looseObject({
	color: z.string(),
	blur: NonNegativeFiniteNumber,
	offsetX: FiniteNumber,
	offsetY: FiniteNumber,
	opacity: FiniteNumber.optional(),
});

export const CanvasDropShadowEffectSchema = z.looseObject({
	type: z.literal("drop-shadow"),
	color: z.string(),
	blur: NonNegativeFiniteNumber,
	offsetX: FiniteNumber,
	offsetY: FiniteNumber,
	spread: NonNegativeFiniteNumber.optional(),
	opacity: FiniteNumber.optional(),
});

export const CanvasBlurEffectSchema = z.looseObject({
	type: z.literal("blur"),
	radius: NonNegativeFiniteNumber,
});

export const CanvasEffectSchema: z.ZodType<CanvasEffect> = z.discriminatedUnion(
	"type",
	[CanvasDropShadowEffectSchema, CanvasBlurEffectSchema],
);

/** Shared by every shadow-bearing node shape (C-03): legacy field + effect list. */
const CanvasEffectStyleShape = {
	shadow: CanvasShadowSchema.optional(),
	effects: z.array(CanvasEffectSchema).optional(),
} as const;

/**
 * A non-negative layout distance (padding edge or gap), bounded by
 * `MAX_FINITE_LAYOUT_MAGNITUDE`.
 *
 * The upper bound is what makes that limit load-bearing rather than merely
 * documented: past it, a value no longer round-trips through the resolver's
 * 1e-4 quantisation without precision loss, so it is rejected here as
 * non-finite-equivalent rather than allowed to produce silently drifting
 * geometry downstream.
 */
const LayoutDistance = NonNegativeFiniteNumber.refine(
	(v) => v <= MAX_FINITE_LAYOUT_MAGNITUDE,
	{
		message: `Layout distance must be <= ${MAX_FINITE_LAYOUT_MAGNITUDE} (MAX_FINITE_LAYOUT_MAGNITUDE)`,
	},
);

/**
 * Auto Layout padding. Deliberately NOT `CanvasInsetsSchema`: that schema
 * backs page-level layout aids, where a negative inset is meaningful (a bleed
 * extends outward past the trim). Layout padding must be non-negative on every
 * edge (TD §6.1), so it validates the same `CanvasInsets` *type* under a
 * stricter *schema* — one inset type, two validation rules.
 */
const CanvasLayoutPaddingSchema: z.ZodType<CanvasInsets> = z.looseObject({
	top: LayoutDistance,
	right: LayoutDistance,
	bottom: LayoutDistance,
	left: LayoutDistance,
});

export const CanvasLayoutItemSchema: z.ZodType<CanvasLayoutItem> =
	z.looseObject({
		positioning: z.enum(["flow", "absolute"]).optional(),
		widthSizing: z.enum(["fixed", "hug", "fill"]).optional(),
		heightSizing: z.enum(["fixed", "hug", "fill"]).optional(),
	});

export const CanvasAutoLayoutSchema: z.ZodType<CanvasAutoLayout> =
	z.looseObject({
		version: z.literal(1),
		direction: z.enum(["horizontal", "vertical"]),
		padding: CanvasLayoutPaddingSchema,
		// Gap never collapses (PRD 0014 §9.3) — an overfull frame overflows and
		// reports `layout-insufficient-space`, so a negative gap is never a
		// legitimate way to express "pull these together".
		gap: LayoutDistance,
		primaryAlign: z.enum(["start", "center", "end"]),
		crossAlign: z.enum(["start", "center", "end"]),
	});

export const CanvasNodeBaseShape = {
	id: z.string().min(1),
	name: z.string().optional(),
	transform: CanvasTransformSchema,
	bounds: CanvasBoundsSchema,
	opacity: FiniteNumber.optional(),
	visible: z.boolean().optional(),
	locked: z.boolean().optional(),
	blendMode: z.string().optional(),
	// Reserved/unused — see CanvasNodeBase.zIndex (C-9).
	zIndex: FiniteNumber.optional(),
	meta: CanvasNodeMetaSchema.optional(),
	layoutItem: CanvasLayoutItemSchema.optional(),
} as const;

export const CanvasNodeBaseSchema: z.ZodType<CanvasNodeBase> =
	z.looseObject(CanvasNodeBaseShape);

const CanvasStrokeStyleShape = {
	strokeOpacity: z.number().min(0).max(1).optional(),
	strokeDash: z.array(NonNegativeFiniteNumber).optional(),
	strokeCap: z.enum(["butt", "round", "square"]).optional(),
	strokeJoin: z.enum(["miter", "round", "bevel"]).optional(),
};

const CanvasArrowHeadSchema = z.enum(["none", "arrow"]);

const CanvasCornerRadiiSchema = z.looseObject({
	topLeft: NonNegativeFiniteNumber,
	topRight: NonNegativeFiniteNumber,
	bottomRight: NonNegativeFiniteNumber,
	bottomLeft: NonNegativeFiniteNumber,
});

export const CanvasRectNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("rect"),
	...CanvasStrokeStyleShape,
	cornerRadii: CanvasCornerRadiiSchema.optional(),
	fill: CanvasFillSchema.optional(),
	...CanvasEffectStyleShape,
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
	radius: NonNegativeFiniteNumber.optional(),
});

export const CanvasEllipseNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("ellipse"),
	...CanvasStrokeStyleShape,
	fill: CanvasFillSchema.optional(),
	...CanvasEffectStyleShape,
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasPolygonNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("polygon"),
	...CanvasStrokeStyleShape,
	sides: IntegerAtLeastThree,
	fill: CanvasFillSchema.optional(),
	...CanvasEffectStyleShape,
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasStarNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("star"),
	...CanvasStrokeStyleShape,
	points: IntegerAtLeastThree,
	innerRadiusRatio: UnitInterval,
	fill: CanvasFillSchema.optional(),
	...CanvasEffectStyleShape,
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasLineNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("line"),
	...CanvasStrokeStyleShape,
	arrowStart: CanvasArrowHeadSchema.optional(),
	arrowEnd: CanvasArrowHeadSchema.optional(),
	points: z.tuple([FiniteNumber, FiniteNumber, FiniteNumber, FiniteNumber]),
	stroke: z.string(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasPathNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("path"),
	...CanvasStrokeStyleShape,
	arrowStart: CanvasArrowHeadSchema.optional(),
	arrowEnd: CanvasArrowHeadSchema.optional(),
	d: z.string().min(1),
	fill: CanvasFillSchema.optional(),
	...CanvasEffectStyleShape,
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasTextNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("text"),
	text: z.string(),
	fontFamily: CanvasFontFamilySchema,
	fontSize: NonNegativeFiniteNumber,
	fontWeight: z.string().optional(),
	fill: CanvasFillSchema,
	...CanvasEffectStyleShape,
	align: z.enum(["left", "center", "right"]).optional(),
});

/**
 * A rich-text span. Every style field is optional — an omitted field means
 * "inherit from the host's default", which is resolved at measure/render time,
 * not here. `text` may legitimately be empty (an empty span is how an editor
 * represents a caret sitting in a freshly-split paragraph).
 */
export const RichTextSpanSchema = z.looseObject({
	text: z.string(),
	fontFamily: CanvasFontFamilySchema.optional(),
	fontSize: NonNegativeFiniteNumber.optional(),
	fontWeight: z.string().optional(),
	italic: z.boolean().optional(),
	underline: z.boolean().optional(),
	strikethrough: z.boolean().optional(),
	// Letter spacing may be negative (tightening), so it is a plain finite number.
	letterSpacing: FiniteNumber.optional(),
	textTransform: z
		.enum(["none", "uppercase", "lowercase", "capitalize"])
		.optional(),
	fill: CanvasFillSchema.optional(),
});

export const RichTextParagraphSchema = z.looseObject({
	align: z.enum(["left", "center", "right"]).optional(),
	// A multiplier of the resolved font size, not an absolute length.
	lineHeight: NonNegativeFiniteNumber.optional(),
	spans: z.array(RichTextSpanSchema),
});

export const CanvasRichTextNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("rich-text"),
	sizing: z.enum(["fixed", "auto-width"]).optional(),
	width: NonNegativeFiniteNumber,
	height: NonNegativeFiniteNumber.optional(),
	paragraphs: z.array(RichTextParagraphSchema),
	overflow: z.enum(["visible", "clip", "auto-height", "ellipsis"]).optional(),
	wrap: z.enum(["none", "word", "character"]).optional(),
	verticalAlign: z.enum(["top", "middle", "bottom"]).optional(),
});

export const CanvasImageNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("image"),
	assetId: z.string().min(1),
	fitMode: z.enum(["fill", "fit", "stretch", "original", "center"]).optional(),
	crop: CanvasImageCropSchema.optional(),
	filters: z.array(ImageFilterSchema).optional(),
	adjustments: CanvasImageAdjustmentsSchema.optional(),
	// DEPRECATED (ADR 0008 decision 3), removal scheduled for
	// `@anvilkit/canvas-core@1.0.0`. Deliberately RETAINED here for the whole
	// deprecation window: `z.looseObject` above would preserve the key either
	// way, but dropping the declaration would silently downgrade a typed field
	// to an unknown key and lose this `min(1)` check. Documents carrying
	// `maskAssetId` must keep parsing exactly as they always have — deprecation
	// is a documentation state, never a parse failure. The migration is a
	// clipping `frame` carrying `shape` (see `CanvasFrameNodeSchema`).
	maskAssetId: z.string().min(1).optional(),
	assetToken: BrandTokenRefSchema.optional(),
	alt: z.string().optional(),
});

/**
 * FR-016: deliberately holds ONLY `assetId` — there is no `markup`/`content`
 * field for inline SVG text to occupy, so raw markup has nowhere to go even
 * under this schema's loose-object (unknown-key-preserving) posture. No
 * renderer in this package ever reads an unknown key, so an attacker-supplied
 * extra field survives as inert data, never as executed markup.
 */
export const CanvasSvgNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("svg"),
	assetId: z.string().min(1),
	alt: z.string().optional(),
});

export const CanvasAiPlaceholderNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("ai-placeholder"),
	jobId: z.string().min(1),
	status: z.enum(["pending", "complete", "error"]),
	sourcePrompt: z.string().optional(),
});

export const CanvasMediaTrimSchema: z.ZodType<CanvasMediaTrim> = z.looseObject({
	start: NonNegativeFiniteNumber.optional(),
	end: NonNegativeFiniteNumber.optional(),
});

const CanvasMediaNodeBaseShape = {
	...CanvasNodeBaseShape,
	assetId: z.string().min(1),
	trim: CanvasMediaTrimSchema.optional(),
	muted: z.boolean().optional(),
	volume: z.number().min(0).max(1).optional(),
} as const;

export const CanvasVideoNodeSchema = z.looseObject({
	...CanvasMediaNodeBaseShape,
	type: z.literal("video"),
	poster: z.string().min(1).optional(),
});

export const CanvasAudioNodeSchema = z.looseObject({
	...CanvasMediaNodeBaseShape,
	type: z.literal("audio"),
});

export const FramePlaceholderSchema: z.ZodType<FramePlaceholder> =
	z.looseObject({
		kind: z.enum(["image", "logo"]),
		assetId: z.string().min(1).optional(),
		assetToken: BrandTokenRefSchema.optional(),
	});

/**
 * The clip geometry of a frame (ADR 0008 decision 2). Optional and additive on
 * `CanvasFrameNode`, so every document written before it existed parses
 * unchanged and needs no migration.
 *
 * A `discriminatedUnion` on `kind` for the same reason `CanvasNodeSchema`
 * discriminates on `type` — O(1) dispatch and a precise error for an unknown
 * tag — and the numeric guards are the SAME refinements the `polygon`/`star`
 * nodes use, so a shape mask and the equivalent drawn shape can never disagree
 * about what a legal side count or inner radius is. `d` is `min(1)` exactly
 * like `CanvasPathNodeSchema.d`: the character allowlist is the serializer's
 * `PATH_D_RE`, applied on the way out, not a second validator here.
 */
export const CanvasFrameShapeSchema: z.ZodType<CanvasFrameShape> =
	z.discriminatedUnion("kind", [
		z.looseObject({ kind: z.literal("rect") }),
		z.looseObject({ kind: z.literal("ellipse") }),
		z.looseObject({ kind: z.literal("polygon"), sides: IntegerAtLeastThree }),
		z.looseObject({
			kind: z.literal("star"),
			points: IntegerAtLeastThree,
			innerRadiusRatio: UnitInterval,
		}),
		z.looseObject({ kind: z.literal("path"), d: z.string().min(1) }),
	]);

// Recursive members. `CanvasGroupNodeSchema` / `CanvasFrameNodeSchema` stay
// concrete object schemas (not `z.lazy`-wrapped) so they carry a readable `type`
// discriminant — only their `children` element is deferred via `z.lazy`, which
// resolves the cyclic reference at parse time. `CanvasNodeSchema` is a
// `discriminatedUnion` on `type`: O(1) dispatch on the literal tag (vs a plain
// union trying all nine members) plus a precise error for an unknown tag.
export const CanvasGroupNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("group"),
	children: z.array(z.lazy((): z.ZodType<CanvasNode> => CanvasNodeSchema)),
});

/**
 * Frame's own (non-recursive) fields. Split out because `children` must be bound
 * to whichever node union is being assembled — the static one below, or the
 * extension-aware one `buildExtendedSchemas` builds — and the two must not drift.
 */
export const CanvasFrameNodeShape = {
	...CanvasNodeBaseShape,
	type: z.literal("frame"),
	clip: z.boolean().optional(),
	shape: CanvasFrameShapeSchema.optional(),
	background: CanvasFillSchema.optional(),
	placeholder: FramePlaceholderSchema.optional(),
	radius: NonNegativeFiniteNumber.optional(),
	cornerRadii: CanvasCornerRadiiSchema.optional(),
	autoLayout: CanvasAutoLayoutSchema.optional(),
} as const;

export const CanvasFrameNodeSchema = z.looseObject({
	...CanvasFrameNodeShape,
	children: z.array(z.lazy((): z.ZodType<CanvasNode> => CanvasNodeSchema)),
});

// --- Local Components (plan 0023 M1-05) ------------------------------------

const CanvasComponentPropertyBaseShape = {
	id: z.string().min(1),
	name: z.string(),
	nodeId: z.string().min(1),
	// Plan 0021 T-028. Shape only: the namespaced-form rule and per-definition
	// uniqueness are `validateSemanticKeys` in `components/`, reported as a
	// fixable list rather than rejecting the whole document at parse.
	semanticKey: z.string().min(1).optional(),
} as const;

export const CanvasComponentPropertySchema: z.ZodType<CanvasComponentProperty> =
	z.discriminatedUnion("kind", [
		z.looseObject({
			...CanvasComponentPropertyBaseShape,
			kind: z.literal("text"),
			targetKind: z.enum(["text", "rich-text"]),
		}),
		z.looseObject({
			...CanvasComponentPropertyBaseShape,
			kind: z.literal("image"),
			targetKind: z.enum(["image", "frame"]),
		}),
		// `stroke` is deliberately not a valid targetField: stroke is
		// string-typed in the IR, so a CanvasFill-valued override has no legal
		// stroke target (C-17). The enum is the enforcement.
		z.looseObject({
			...CanvasComponentPropertyBaseShape,
			kind: z.literal("color"),
			targetField: z.enum(["fill", "background"]),
		}),
		z.looseObject({
			...CanvasComponentPropertyBaseShape,
			kind: z.literal("visibility"),
		}),
	]);

export const CanvasTextOverrideValueSchema: z.ZodType<CanvasTextOverrideValue> =
	z
		.discriminatedUnion("kind", [
			z.looseObject({
				kind: z.literal("plain"),
				text: z.string().max(MAX_COMPONENT_TEXT_OVERRIDE_CHARS),
			}),
			z.looseObject({
				kind: z.literal("rich"),
				paragraphs: z
					.array(RichTextParagraphSchema)
					.max(MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE),
			}),
		])
		.superRefine((value, ctx) => {
			// The rich-value caps that need cross-field arithmetic (D-3): spans
			// per paragraph, and total characters summed across every span —
			// the same ceiling one plain override gets.
			if (value.kind !== "rich") return;
			let chars = 0;
			for (const [index, paragraph] of value.paragraphs.entries()) {
				if (paragraph.spans.length > MAX_COMPONENT_RICH_SPANS_PER_PARAGRAPH) {
					ctx.addIssue({
						code: "custom",
						path: ["paragraphs", index, "spans"],
						message: `Paragraph carries ${paragraph.spans.length} spans (max ${MAX_COMPONENT_RICH_SPANS_PER_PARAGRAPH}).`,
					});
				}
				for (const span of paragraph.spans) {
					chars += span.text.length;
				}
			}
			if (chars > MAX_COMPONENT_TEXT_OVERRIDE_CHARS) {
				ctx.addIssue({
					code: "custom",
					path: ["paragraphs"],
					message: `Rich override carries ${chars} characters (max ${MAX_COMPONENT_TEXT_OVERRIDE_CHARS}).`,
				});
			}
		});

export const CanvasComponentOverrideSchema: z.ZodType<CanvasComponentOverride> =
	z.discriminatedUnion("kind", [
		z.looseObject({
			kind: z.literal("text"),
			value: CanvasTextOverrideValueSchema,
		}),
		z.looseObject({ kind: z.literal("image"), assetId: z.string().min(1) }),
		z.looseObject({ kind: z.literal("color"), value: CanvasFillSchema }),
		z.looseObject({ kind: z.literal("visibility"), visible: z.boolean() }),
	]);

/** The raw parsed shape, before the legacy-`componentId` normalization below. */
const CanvasComponentInstanceNodeObject = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("component-instance"),
	/**
	 * PRD 0015's shape. Optional and legacy-only: the transform below rewrites
	 * it into `source` and drops it, so no parsed node ever carries both.
	 */
	componentId: z.string().min(1).optional(),
	source: CanvasIRComponentSourceRefSchema.optional(),
	/** Plan 0021 T-026. Partial and possibly stale by design — see the type. */
	variantSelection: z.record(z.string().min(1), z.string().min(1)).optional(),
	overrides: z
		.record(z.string(), CanvasComponentOverrideSchema)
		.superRefine((map, ctx) => {
			const size = Object.keys(map).length;
			if (size > MAX_COMPONENT_OVERRIDES_PER_INSTANCE) {
				ctx.addIssue({
					code: "custom",
					message: `Instance carries ${size} overrides (max ${MAX_COMPONENT_OVERRIDES_PER_INSTANCE}).`,
				});
			}
		})
		.optional(),
});

/**
 * The `component-instance` member of BOTH node unions.
 *
 * ## The legacy `componentId` migration lives here, not in `CANVAS_IR_MIGRATIONS`
 *
 * PRD 0015 shipped instances carrying a bare `componentId`, and it shipped them
 * **at IR v3** — the same version this build writes. `CANVAS_IR_MIGRATIONS` is
 * keyed by version and `migrateCanvasIR` short-circuits when a document is
 * already current, so a `2 -> 3` step would never see those documents. A
 * version-keyed migration is simply the wrong instrument for a shape change
 * that does not cross a version boundary.
 *
 * Normalizing in the schema instead means every path that parses IR converges
 * on the canonical shape with no per-caller opt-in: `migrateCanvasIR`, a bare
 * `CanvasIRSchema.parse`, the collab `decodeCanvasIR` path, and
 * `instantiateTemplate` all inherit it from one implementation.
 *
 * It is idempotent by construction — an already-canonical node takes the first
 * branch and is returned unchanged — and it preserves unknown keys, because the
 * object is `looseObject` and the transform spreads the parsed rest (CON-5).
 */
export const CanvasComponentInstanceNodeSchema =
	CanvasComponentInstanceNodeObject.transform((node, ctx) => {
		// Both fields are destructured OFF and `source` is put back explicitly in
		// every branch. Returning `rest` directly would keep `source` optional in
		// the inferred output type — the parsed node would not satisfy
		// `CanvasComponentInstanceNode`, and the discriminated union it feeds
		// would stop being assignable to `z.ZodType<CanvasNode>`.
		const { componentId, source, ...rest } = node;
		if (source) return { ...rest, source };
		if (componentId === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["source"],
				message:
					'A component-instance needs a "source" (or the legacy "componentId" it migrates from).',
			});
			return z.NEVER;
		}
		return { ...rest, source: { kind: "local" as const, componentId } };
	});

export const CanvasNodeSchema: z.ZodType<CanvasNode> = z.discriminatedUnion(
	"type",
	[
		CanvasGroupNodeSchema,
		CanvasFrameNodeSchema,
		CanvasRectNodeSchema,
		CanvasEllipseNodeSchema,
		CanvasPolygonNodeSchema,
		CanvasStarNodeSchema,
		CanvasLineNodeSchema,
		CanvasPathNodeSchema,
		CanvasTextNodeSchema,
		CanvasRichTextNodeSchema,
		CanvasImageNodeSchema,
		CanvasSvgNodeSchema,
		CanvasAiPlaceholderNodeSchema,
		CanvasVideoNodeSchema,
		CanvasAudioNodeSchema,
		CanvasComponentInstanceNodeSchema,
	],
);

export const CanvasPageVariantSourceSchema: z.ZodType<CanvasPageVariantSource> =
	z.looseObject({
		sourcePageId: z.string().min(1),
		presetId: z.string().min(1),
		presetVersion: z.string().min(1),
	});

/**
 * `CanvasPage`'s own (non-recursive) fields, split out for the same reason as
 * `CanvasFrameNodeShape`: `root` must bind to whichever node union is being
 * assembled — the static one below, or the extension-aware one
 * `buildExtendedSchemas` builds — and every OTHER page field (notably
 * `variantSource`/`animation`) must not drift between the two. Both paths
 * spread this shape rather than re-declaring it (P0-3).
 */
export const CanvasPageShape = {
	id: z.string().min(1),
	name: z.string().optional(),
	size: CanvasPageSizeSchema,
	background: CanvasPageBackgroundSchema,
	variantSource: CanvasPageVariantSourceSchema.optional(),
	animation: CanvasAnimationSchema.optional(),
	layoutAids: CanvasPageLayoutAidsSchema.optional(),
} as const;

export const CanvasPageSchema: z.ZodType<CanvasPage> = z.looseObject({
	...CanvasPageShape,
	root: CanvasGroupNodeSchema,
});

export const CanvasIRMetadataSchema: z.ZodType<CanvasIRMetadata> =
	z.looseObject({
		createdAt: z.string().min(1),
		updatedAt: z.string().min(1),
		ownerId: z.string().optional(),
		brandId: z.string().optional(),
	});

/**
 * The CanvasIR schema version this build emits and treats as current.
 *
 * Policy: **migrate-on-read, write current.** Anything parsed through
 * `migrateCanvasIR`/`runtime.migrate` comes out at this version, and
 * builders/serializers emit it. This is the single version literal — the
 * static schema below and `buildExtendedSchemas` both derive from it, so the
 * two can never drift.
 */
export const CANVAS_IR_VERSION = "3" satisfies CanvasIR["version"];

export const CanvasDocumentKindSchema: z.ZodType<CanvasDocumentKind> = z.enum([
	"design",
	"template-instance",
	"export-variant",
]);

/**
 * `CanvasIR`'s own fields other than `pages`, split out for the same reason
 * as {@link CanvasPageShape}: `pages` must bind to whichever page schema is
 * being assembled (static vs. extension-aware), while every other top-level
 * field must validate identically either way (P0-3).
 */
/**
 * What a reader needs in order to open the document (TD §5.1).
 *
 * `requiredCapabilities` is `z.array(z.string())` and **must never become a
 * `z.enum`**. This reader rejects unknown enum values while tolerating unknown
 * object keys, so a closed capability enum would make any document declaring a
 * *future* capability fail schema parse outright — before the compatibility
 * check, before `layout-capability-unsupported`, and before the read-only
 * materialized preview that AC-010's graceful degradation depends on. The
 * openness has to live here, at the schema, because every later stage is
 * downstream of a successful parse.
 *
 * `schemaVersion` is pinned to `CANVAS_IR_VERSION` (the same literal the
 * document's own `version` uses), so a compatibility record claiming a
 * different version than the document it sits on is a parse error rather
 * than a silently inconsistent document.
 */
const CanvasDocumentCompatibilitySchema: z.ZodType<CanvasDocumentCompatibility> =
	z.looseObject({
		schemaVersion: z.literal(CANVAS_IR_VERSION),
		minReaderSchemaVersion: z.string().min(1),
		requiredCapabilities: z.array(z.string()),
	});

/**
 * Freshness stamp for the materialized layout cache (TD §5.3). Purely
 * derived data — absence is always valid and always safe.
 */
const CanvasLayoutMaterializationSchema: z.ZodType<CanvasLayoutMaterialization> =
	z.looseObject({
		engineVersion: z.literal(1),
		inputHash: z.string().min(1),
		resolvedAtRevision: FiniteNumber,
		measurementManifestHash: z.string().min(1).optional(),
	});

/**
 * Iterative node count over an already-parsed Source tree — the D-3
 * per-definition cap needs the total, and the parse itself has just walked
 * the same structure, so this is a second cheap O(n) pass, not a schema
 * recursion.
 */
function countSubtreeNodes(root: unknown): number {
	let count = 0;
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		count += 1;
		const children = (node as { children?: unknown }).children;
		if (Array.isArray(children)) {
			for (const child of children) stack.push(child);
		}
	}
	return count;
}

/**
 * `CanvasComponentDefinition`'s non-recursive fields, split out for the same
 * reason as `CanvasFrameNodeShape`: `root` must bind to whichever node union
 * is being assembled — static or extension-aware — and every other field must
 * not drift between the two paths.
 */
export const CanvasComponentDefinitionShape = {
	id: z.string().min(1),
	name: z.string(),
	revision: z.int().nonnegative(),
	properties: z
		.array(CanvasComponentPropertySchema)
		.max(MAX_COMPONENT_PROPERTIES_PER_COMPONENT),
	// Plan 0021 T-024. Shape only here; the cross-field rules (unknown axis,
	// duplicate canonical selection, default exists) are `validateComponentVariantSet`
	// in `components/`, because they are reported as a LIST for an author to fix
	// rather than as a parse failure that rejects the whole document.
	variants: CanvasComponentVariantSetSchema.optional(),
	// Plan 0021 T-036 — in the canonical payload, so it participates in the
	// snapshot digest. Cross-field rules (unknown property ids, identity-shaped
	// keys) are `validateBrandComponentPolicy`, reported as a fixable list.
	policy: CanvasBrandComponentPolicySchema.optional(),
	createdAt: z.string().min(1).optional(),
	updatedAt: z.string().min(1).optional(),
} as const;

/**
 * Build the `ir.components` Registry schema against a node union — the
 * static `CanvasNodeSchema` below, or the extended union
 * `buildExtendedSchemas` assembles, so a custom node kind nested inside a
 * Source tree validates exactly like one nested inside a page (DEV-M1-B).
 * Enforces Registry key === `definition.id` (INV-1).
 */
export function buildCanvasComponentRegistrySchema(
	nodeSchema: z.ZodType<CanvasNode>,
): z.ZodType<CanvasComponentRegistry> {
	const definition = z.looseObject({
		...CanvasComponentDefinitionShape,
		root: z.lazy(() => nodeSchema),
	});
	return z
		.record(z.string().min(1), definition)
		.superRefine((registry, ctx) => {
			const entries = Object.entries(registry);
			if (entries.length > MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT) {
				ctx.addIssue({
					code: "custom",
					message: `Registry carries ${entries.length} definitions (max ${MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT}).`,
				});
			}
			for (const [key, def] of entries) {
				if (key !== def.id) {
					ctx.addIssue({
						code: "custom",
						path: [key],
						message: `Registry key "${key}" must equal definition.id "${def.id}" (INV-1).`,
					});
				}
				const nodeCount = countSubtreeNodes(def.root);
				if (nodeCount > MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION) {
					ctx.addIssue({
						code: "custom",
						path: [key, "root"],
						message: `Definition "${def.id}" carries ${nodeCount} Source nodes (max ${MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION}).`,
					});
				}
			}
		}) as unknown as z.ZodType<CanvasComponentRegistry>;
}

export const CanvasComponentRegistrySchema: z.ZodType<CanvasComponentRegistry> =
	buildCanvasComponentRegistrySchema(CanvasNodeSchema);

/**
 * Build the `ir.externalComponentSnapshots` schema against a node union
 * (plan 0021 T-014), for the same reason the Registry builder exists: a custom
 * node kind inside an external Source tree must validate exactly like one
 * inside a local Source tree.
 *
 * ## The key assertion is the point of this schema
 *
 * Every entry's key must equal `snapshotKey(entry.ref)`. Without it a document
 * could store component *A*'s bytes under component *B*'s key, and the resolver
 * — which looks up by key — would hand back the wrong component while every
 * individual field still validated (TD §22.1, cross-library confusion). This is
 * why the key codec had to move down to `ir/` (see `ir/snapshot-key.ts`): rank 1
 * cannot import it from `component-libraries/` at rank 4, so before the move
 * this check was simply not expressible where the schema lives.
 *
 * Entries are `looseObject` like the rest of the IR (CON-5). That is deliberate
 * and NOT a weakening of the strict Provider envelope: strictness belongs at the
 * moment untrusted bytes arrive (`component-libraries/admission.ts`), whereas
 * this schema parses a document that already contains admitted snapshots and
 * must round-trip a newer peer's unknown fields rather than delete them.
 */
export function buildCanvasExternalSnapshotRegistrySchema(
	nodeSchema: z.ZodType<CanvasNode>,
): z.ZodType<CanvasExternalComponentSnapshotRegistry> {
	const snapshot = z.looseObject({
		ref: CanvasIRExternalComponentRefSchema,
		definition: z.looseObject({
			...CanvasComponentDefinitionShape,
			root: z.lazy(() => nodeSchema),
		}),
		dependencies: z
			.array(CanvasIRExternalComponentRefSchema)
			.max(MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT),
		canonicalFormatVersion: z.int().positive(),
		fetchedAt: z.string().min(1).optional(),
	});
	/**
	 * Keys are validated against the RAW input, before `z.record` ever sees it.
	 *
	 * `z.record` silently drops a `__proto__` key — it never even runs the key
	 * schema on it (verified against zod@4.4.3). Dropping is the safe direction,
	 * but it is silent: a document carrying such a key would load "successfully"
	 * minus that snapshot, and the instance referencing it would then render as an
	 * unexplained missing component. Checking the raw own-property names first
	 * turns that into a named parse failure, and routes every bad key — reserved
	 * or merely malformed — through the same `isSnapshotKey` check.
	 */
	const keysChecked = z.unknown().superRefine((raw, ctx) => {
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
		for (const key of Object.getOwnPropertyNames(raw)) {
			if (isSnapshotKey(key)) continue;
			ctx.addIssue({
				code: "custom",
				path: [key],
				message: `"${key}" is not a snapshot key. Keys must be libraryId/componentId/version/integrity, each segment URI-component-encoded.`,
			});
		}
	});

	return keysChecked
		.pipe(z.record(z.string(), snapshot))
		.superRefine((registry, ctx) => {
			const entries = Object.entries(registry);
			if (entries.length > MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT) {
				ctx.addIssue({
					code: "custom",
					message: `Document carries ${entries.length} external component snapshots (max ${MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT}).`,
				});
			}
			for (const [key, entry] of entries) {
				let derived: string;
				try {
					derived = snapshotKey(entry.ref);
				} catch (error) {
					ctx.addIssue({
						code: "custom",
						path: [key, "ref"],
						message: `Snapshot "${key}" has a reference no key can be derived from: ${error instanceof Error ? error.message : String(error)}`,
					});
					continue;
				}
				if (key !== derived) {
					ctx.addIssue({
						code: "custom",
						path: [key],
						message: `Snapshot key "${key}" must equal snapshotKey(entry.ref) "${derived}" — a mismatched key lets one component be served under another's identity (TD §22.1).`,
					});
				}
			}
		}) as unknown as z.ZodType<CanvasExternalComponentSnapshotRegistry>;
}

export const CanvasExternalComponentSnapshotRegistrySchema: z.ZodType<CanvasExternalComponentSnapshotRegistry> =
	buildCanvasExternalSnapshotRegistrySchema(CanvasNodeSchema);

/**
 * Normalize an empty Registry to omission (INV-10): `components: {}` and an
 * absent key must be indistinguishable downstream. Shared by BOTH IR schema
 * paths so parity holds by construction.
 */
export function omitEmptyComponents<
	T extends {
		components?: CanvasComponentRegistry;
		externalComponentSnapshots?: CanvasExternalComponentSnapshotRegistry;
	},
>(ir: T): T {
	let out = ir;
	if (out.components && Object.keys(out.components).length === 0) {
		const { components: _empty, ...rest } = out;
		out = rest as unknown as T;
	}
	// Same INV-10 rule for the external snapshot registry (plan 0021 T-014):
	// `{}` and an absent key must be indistinguishable downstream, so a document
	// that admitted and then removed every external component is byte-identical
	// to one that never had any.
	if (
		out.externalComponentSnapshots &&
		Object.keys(out.externalComponentSnapshots).length === 0
	) {
		const { externalComponentSnapshots: _none, ...rest } = out;
		out = rest as unknown as T;
	}
	return out;
}

export const CanvasIRShape = {
	version: z.literal(CANVAS_IR_VERSION),
	documentKind: CanvasDocumentKindSchema.optional(),
	id: z.string().min(1),
	title: z.string(),
	assets: z.record(z.string(), CanvasAssetRefSchema),
	metadata: CanvasIRMetadataSchema,
	compatibility: CanvasDocumentCompatibilitySchema.optional(),
	layoutMaterialization: CanvasLayoutMaterializationSchema.optional(),
} as const;

export const CanvasIRSchema: z.ZodType<CanvasIR> = z
	.looseObject({
		...CanvasIRShape,
		pages: z.array(CanvasPageSchema).min(1),
		// Bound per-path, NOT in `CanvasIRShape`: the extended path must bind
		// its own union or extension kinds inside Source trees get rejected.
		components: CanvasComponentRegistrySchema.optional(),
		externalComponentSnapshots:
			CanvasExternalComponentSnapshotRegistrySchema.optional(),
	})
	.transform(omitEmptyComponents) as unknown as z.ZodType<CanvasIR>;

const DEFAULT_MIGRATIONS = createMigrationRegistry();

/**
 * Parse + forward-migrate an untrusted/persisted IR to the current schema
 * version, then validate it. This is the single seam for schema evolution.
 *
 * Policy: **migrate-on-read, write current** (`CANVAS_IR_VERSION`). A
 * supported older version (see `CANVAS_IR_MIGRATIONS`) is upgraded step by
 * step before the `CanvasIRSchema.parse`, so persisted and peer-supplied
 * documents (e.g. collaborative editing) keep loading as the schema grows —
 * and always come out stamped with the current version. An unsupported
 * version is rejected with a clear, actionable error rather than a cryptic
 * schema failure.
 *
 * Prefer this over a bare `CanvasIRSchema.parse` when decoding persisted or
 * peer-supplied IR.
 */
export function migrateCanvasIR(raw: unknown): CanvasIR {
	const version =
		raw && typeof raw === "object"
			? (raw as { version?: unknown }).version
			: undefined;
	const supported =
		version === CANVAS_IR_VERSION ||
		(typeof version === "string" && DEFAULT_MIGRATIONS.has(version));
	if (!supported) {
		throw new Error(
			`Unsupported CanvasIR version ${JSON.stringify(version)} (current is "${CANVAS_IR_VERSION}"). No migration path is registered.`,
		);
	}
	return CanvasIRSchema.parse(
		DEFAULT_MIGRATIONS.migrate(raw, CANVAS_IR_VERSION),
	);
}
