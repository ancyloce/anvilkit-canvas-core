import { z } from "zod";
import type {
	CanvasAssetRef,
	CanvasBounds,
	CanvasGroupNode,
	CanvasImageCrop,
	CanvasIR,
	CanvasIRMetadata,
	CanvasNode,
	CanvasNodeBase,
	CanvasNodeMeta,
	CanvasPage,
	CanvasPageBackground,
	CanvasPageSize,
	CanvasTransform,
	ImageFilter,
} from "./types.js";

/**
 * Object schemas use `z.looseObject` (preserve unknown keys) rather than the
 * Zod default (`strip`, which silently drops them). The Canvas IR is a versioned
 * (`version: "1"`) persisted + collaborative wire format, so a replica on an
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

export const CanvasNodeMetaSchema: z.ZodType<CanvasNodeMeta> = z.looseObject({
	aiSource: CanvasAiSourceMetaSchema.optional(),
});

const CanvasNodeBaseShape = {
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
	fill: z.string().optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
	radius: NonNegativeFiniteNumber.optional(),
});

export const CanvasEllipseNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("ellipse"),
	fill: z.string().optional(),
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
	fill: z.string().optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasTextNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("text"),
	text: z.string(),
	fontFamily: z.string().min(1),
	fontSize: NonNegativeFiniteNumber,
	fontWeight: z.string().optional(),
	fill: z.string(),
	align: z.enum(["left", "center", "right"]).optional(),
});

export const CanvasImageNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("image"),
	assetId: z.string().min(1),
	crop: CanvasImageCropSchema.optional(),
	filters: z.array(ImageFilterSchema).optional(),
	maskAssetId: z.string().min(1).optional(),
});

export const CanvasAiPlaceholderNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("ai-placeholder"),
	jobId: z.string().min(1),
	status: z.enum(["pending", "complete", "error"]),
	sourcePrompt: z.string().optional(),
});

// Recursive pair. `CanvasGroupNodeSchema` stays a concrete object schema (not
// `z.lazy`-wrapped) so it carries a readable `type` discriminant — only its
// `children` element is deferred via `z.lazy`, which resolves the cyclic
// reference at parse time. `CanvasNodeSchema` is a `discriminatedUnion` on
// `type`: O(1) dispatch on the literal tag (vs a plain union trying all eight
// members) plus a precise error for an unknown tag.
export const CanvasGroupNodeSchema = z.looseObject({
	...CanvasNodeBaseShape,
	type: z.literal("group"),
	children: z.array(z.lazy((): z.ZodType<CanvasNode> => CanvasNodeSchema)),
});

export const CanvasNodeSchema: z.ZodType<CanvasNode> = z.discriminatedUnion(
	"type",
	[
		CanvasGroupNodeSchema,
		CanvasRectNodeSchema,
		CanvasEllipseNodeSchema,
		CanvasLineNodeSchema,
		CanvasPathNodeSchema,
		CanvasTextNodeSchema,
		CanvasImageNodeSchema,
		CanvasAiPlaceholderNodeSchema,
	],
);

export const CanvasPageSchema: z.ZodType<CanvasPage> = z.looseObject({
	id: z.string().min(1),
	name: z.string().optional(),
	size: CanvasPageSizeSchema,
	background: CanvasPageBackgroundSchema,
	root: CanvasGroupNodeSchema,
});

export const CanvasIRMetadataSchema: z.ZodType<CanvasIRMetadata> =
	z.looseObject({
		createdAt: z.string().min(1),
		updatedAt: z.string().min(1),
		ownerId: z.string().optional(),
		brandId: z.string().optional(),
	});

export const CanvasIRSchema: z.ZodType<CanvasIR> = z.looseObject({
	version: z.literal("1"),
	id: z.string().min(1),
	title: z.string(),
	pages: z.array(CanvasPageSchema).min(1),
	assets: z.record(z.string(), CanvasAssetRefSchema),
	metadata: CanvasIRMetadataSchema,
});

/** The CanvasIR schema version this build emits and treats as current. */
export const CANVAS_IR_VERSION = "1" as const;

/**
 * Parse + forward-migrate an untrusted/persisted IR to the current schema
 * version, then validate it. This is the single seam for schema evolution:
 * when a future `version: "2"` ships, upgrade older `raw` to the current shape
 * *here* (e.g. `if (version === "1") raw = upgradeV1ToV2(raw)`) before the
 * `CanvasIRSchema.parse` below. Today only `"1"` exists, so any other version is
 * rejected with a clear, actionable error rather than a cryptic schema failure.
 *
 * Prefer this over a bare `CanvasIRSchema.parse` when decoding persisted or
 * peer-supplied IR (e.g. collaborative editing) so old documents keep loading
 * as the schema grows.
 */
export function migrateCanvasIR(raw: unknown): CanvasIR {
	const version =
		raw && typeof raw === "object"
			? (raw as { version?: unknown }).version
			: undefined;
	if (version !== CANVAS_IR_VERSION) {
		throw new Error(
			`Unsupported CanvasIR version ${JSON.stringify(version)} (expected "${CANVAS_IR_VERSION}"). No migration path is registered.`,
		);
	}
	return CanvasIRSchema.parse(raw);
}
