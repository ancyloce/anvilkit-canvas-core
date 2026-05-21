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

const FiniteNumber = z.number().refine((v) => Number.isFinite(v), {
	message: "must be a finite number",
});

const NonNegativeFiniteNumber = FiniteNumber.refine((v) => v >= 0, {
	message: "must be >= 0",
});

export const CanvasTransformSchema: z.ZodType<CanvasTransform> = z.object({
	x: FiniteNumber,
	y: FiniteNumber,
	rotation: FiniteNumber,
	scaleX: FiniteNumber,
	scaleY: FiniteNumber,
	skewX: FiniteNumber.optional(),
	skewY: FiniteNumber.optional(),
});

export const CanvasBoundsSchema: z.ZodType<CanvasBounds> = z.object({
	width: NonNegativeFiniteNumber,
	height: NonNegativeFiniteNumber,
});

export const CanvasPageSizeSchema: z.ZodType<CanvasPageSize> = z.object({
	width: NonNegativeFiniteNumber,
	height: NonNegativeFiniteNumber,
	unit: z.enum(["px", "mm", "in"]),
	dpi: FiniteNumber.optional(),
});

export const CanvasPageBackgroundSchema: z.ZodType<CanvasPageBackground> =
	z.object({
		kind: z.enum(["solid", "image", "gradient"]),
		value: z.string(),
	});

export const CanvasAssetRefSchema: z.ZodType<CanvasAssetRef> = z.object({
	id: z.string().min(1),
	uri: z.string().min(1),
	mimeType: z.string().optional(),
	width: NonNegativeFiniteNumber.optional(),
	height: NonNegativeFiniteNumber.optional(),
	byteSize: NonNegativeFiniteNumber.optional(),
});

export const CanvasImageCropSchema: z.ZodType<CanvasImageCrop> = z.object({
	x: FiniteNumber,
	y: FiniteNumber,
	width: NonNegativeFiniteNumber,
	height: NonNegativeFiniteNumber,
});

export const ImageFilterSchema: z.ZodType<ImageFilter> = z.object({
	kind: z.string().min(1),
	params: z
		.record(z.string(), z.union([z.number(), z.string(), z.boolean()]))
		.optional(),
});

const CanvasAiSourceMetaSchema = z.object({
	prompt: z.string().optional(),
	model: z.string().optional(),
	ts: FiniteNumber,
});

export const CanvasNodeMetaSchema: z.ZodType<CanvasNodeMeta> = z.object({
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
	z.object(CanvasNodeBaseShape);

export const CanvasRectNodeSchema = z.object({
	...CanvasNodeBaseShape,
	type: z.literal("rect"),
	fill: z.string().optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
	radius: NonNegativeFiniteNumber.optional(),
});

export const CanvasEllipseNodeSchema = z.object({
	...CanvasNodeBaseShape,
	type: z.literal("ellipse"),
	fill: z.string().optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasLineNodeSchema = z.object({
	...CanvasNodeBaseShape,
	type: z.literal("line"),
	points: z.tuple([FiniteNumber, FiniteNumber, FiniteNumber, FiniteNumber]),
	stroke: z.string(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasPathNodeSchema = z.object({
	...CanvasNodeBaseShape,
	type: z.literal("path"),
	d: z.string().min(1),
	fill: z.string().optional(),
	stroke: z.string().optional(),
	strokeWidth: NonNegativeFiniteNumber.optional(),
});

export const CanvasTextNodeSchema = z.object({
	...CanvasNodeBaseShape,
	type: z.literal("text"),
	text: z.string(),
	fontFamily: z.string().min(1),
	fontSize: NonNegativeFiniteNumber,
	fontWeight: z.string().optional(),
	fill: z.string(),
	align: z.enum(["left", "center", "right"]).optional(),
});

export const CanvasImageNodeSchema = z.object({
	...CanvasNodeBaseShape,
	type: z.literal("image"),
	assetId: z.string().min(1),
	crop: CanvasImageCropSchema.optional(),
	filters: z.array(ImageFilterSchema).optional(),
	maskAssetId: z.string().min(1).optional(),
});

export const CanvasAiPlaceholderNodeSchema = z.object({
	...CanvasNodeBaseShape,
	type: z.literal("ai-placeholder"),
	jobId: z.string().min(1),
	status: z.enum(["pending", "complete", "error"]),
	sourcePrompt: z.string().optional(),
});

// Recursive pair: CanvasGroupNodeSchema references CanvasNodeSchema (via z.lazy),
// CanvasNodeSchema unions CanvasGroupNodeSchema with all leaf schemas (via z.lazy).
// Both wrapped in z.lazy so the cyclic reference resolves only at parse time.
export const CanvasGroupNodeSchema: z.ZodType<CanvasGroupNode> = z.lazy(() =>
	z.object({
		...CanvasNodeBaseShape,
		type: z.literal("group"),
		children: z.array(CanvasNodeSchema),
	}),
);

export const CanvasNodeSchema: z.ZodType<CanvasNode> = z.lazy(() =>
	z.union([
		CanvasGroupNodeSchema,
		CanvasRectNodeSchema,
		CanvasEllipseNodeSchema,
		CanvasLineNodeSchema,
		CanvasPathNodeSchema,
		CanvasTextNodeSchema,
		CanvasImageNodeSchema,
		CanvasAiPlaceholderNodeSchema,
	]),
);

export const CanvasPageSchema: z.ZodType<CanvasPage> = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
	size: CanvasPageSizeSchema,
	background: CanvasPageBackgroundSchema,
	root: CanvasGroupNodeSchema,
});

export const CanvasIRMetadataSchema: z.ZodType<CanvasIRMetadata> = z.object({
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
	ownerId: z.string().optional(),
	brandId: z.string().optional(),
});

export const CanvasIRSchema: z.ZodType<CanvasIR> = z.object({
	version: z.literal("1"),
	id: z.string().min(1),
	title: z.string(),
	pages: z.array(CanvasPageSchema).min(1),
	assets: z.record(z.string(), CanvasAssetRefSchema),
	metadata: CanvasIRMetadataSchema,
});
