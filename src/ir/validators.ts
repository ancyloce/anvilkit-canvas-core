import { z } from "zod";
import { createMigrationRegistry } from "./migrations.js";
import type {
	BrandTokenRef,
	CanvasAnimation,
	CanvasAssetRef,
	CanvasBounds,
	CanvasDocumentKind,
	CanvasFill,
	CanvasFontFamily,
	CanvasGradientFill,
	CanvasGradientStop,
	CanvasGroupNode,
	CanvasImageCrop,
	CanvasIR,
	CanvasIRMetadata,
	CanvasMediaTrim,
	CanvasNode,
	CanvasNodeBase,
	CanvasNodeMeta,
	CanvasPage,
	CanvasPageBackground,
	CanvasPageSize,
	CanvasPageVariantSource,
	CanvasShadow,
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

export const CanvasNodeBaseShape = {
	id: z.string().min(1),
	name: z.string().optional(),
	transform: CanvasTransformSchema,
	bounds: CanvasBoundsSchema,
	opacity: FiniteNumber.optional(),
	visible: z.boolean().optional(),
	locked: z.boolean().optional(),
	blendMode: z.string().optional(),
	zIndex: FiniteNumber,
	meta: CanvasNodeMetaSchema.optional(),
} as const;

export const CanvasNodeBaseSchema: z.ZodType<CanvasNodeBase> =
	z.looseObject(CanvasNodeBaseShape);

export const CanvasRectNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("rect"),
	fill: CanvasFillSchema.optional(),
	shadow: CanvasShadowSchema.optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
	radius: NonNegativeFiniteNumber.optional(),
});

export const CanvasEllipseNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("ellipse"),
	fill: CanvasFillSchema.optional(),
	shadow: CanvasShadowSchema.optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasPolygonNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("polygon"),
	sides: IntegerAtLeastThree,
	fill: CanvasFillSchema.optional(),
	shadow: CanvasShadowSchema.optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasStarNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("star"),
	points: IntegerAtLeastThree,
	innerRadiusRatio: UnitInterval,
	fill: CanvasFillSchema.optional(),
	shadow: CanvasShadowSchema.optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasLineNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("line"),
	points: z.tuple([FiniteNumber, FiniteNumber, FiniteNumber, FiniteNumber]),
	stroke: z.string(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasPathNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("path"),
	d: z.string().min(1),
	fill: CanvasFillSchema.optional(),
	shadow: CanvasShadowSchema.optional(),
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
	shadow: CanvasShadowSchema.optional(),
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
	width: NonNegativeFiniteNumber,
	height: NonNegativeFiniteNumber.optional(),
	paragraphs: z.array(RichTextParagraphSchema),
	overflow: z.enum(["visible", "clip", "auto-height", "ellipsis"]).optional(),
	wrap: z.enum(["none", "word", "character"]).optional(),
});

export const CanvasImageNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("image"),
	assetId: z.string().min(1),
	crop: CanvasImageCropSchema.optional(),
	filters: z.array(ImageFilterSchema).optional(),
	maskAssetId: z.string().min(1).optional(),
	assetToken: BrandTokenRefSchema.optional(),
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
	background: CanvasFillSchema.optional(),
	placeholder: FramePlaceholderSchema.optional(),
	radius: NonNegativeFiniteNumber.optional(),
} as const;

export const CanvasFrameNodeSchema = z.looseObject({
	...CanvasFrameNodeShape,
	children: z.array(z.lazy((): z.ZodType<CanvasNode> => CanvasNodeSchema)),
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
	],
);

export const CanvasPageVariantSourceSchema: z.ZodType<CanvasPageVariantSource> =
	z.looseObject({
		sourcePageId: z.string().min(1),
		presetId: z.string().min(1),
		presetVersion: z.string().min(1),
	});

export const CanvasPageSchema: z.ZodType<CanvasPage> = z.looseObject({
	id: z.string().min(1),
	name: z.string().optional(),
	size: CanvasPageSizeSchema,
	background: CanvasPageBackgroundSchema,
	root: CanvasGroupNodeSchema,
	variantSource: CanvasPageVariantSourceSchema.optional(),
	animation: CanvasAnimationSchema.optional(),
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
export const CANVAS_IR_VERSION = "2" satisfies CanvasIR["version"];

export const CanvasDocumentKindSchema: z.ZodType<CanvasDocumentKind> = z.enum([
	"design",
	"template-instance",
	"export-variant",
]);

export const CanvasIRSchema: z.ZodType<CanvasIR> = z.looseObject({
	version: z.literal(CANVAS_IR_VERSION),
	documentKind: CanvasDocumentKindSchema.optional(),
	id: z.string().min(1),
	title: z.string(),
	pages: z.array(CanvasPageSchema).min(1),
	assets: z.record(z.string(), CanvasAssetRefSchema),
	metadata: CanvasIRMetadataSchema,
});

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
