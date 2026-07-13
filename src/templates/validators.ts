import { z } from "zod";
import { CanvasIRSchema } from "../ir/validators.js";
import type {
	CanvasSafeArea,
	CanvasSizePreset,
	CanvasTemplateDefinition,
	TemplateAssetAttribution,
	TemplateGovernancePolicy,
	TemplateLicense,
	TemplateSlot,
	TemplateSourceMeta,
	TemplateVariable,
} from "./types.js";

export const CanvasSafeAreaSchema: z.ZodType<CanvasSafeArea> = z.looseObject({
	top: z.number(),
	right: z.number(),
	bottom: z.number(),
	left: z.number(),
});

export const CanvasSizePresetSchema: z.ZodType<CanvasSizePreset> =
	z.looseObject({
		id: z.string().min(1),
		version: z.string().min(1),
		label: z.string().min(1),
		width: z.number().positive(),
		height: z.number().positive(),
		unit: z.enum(["px", "mm", "in"]),
		dpi: z.number().positive().optional(),
		safeArea: CanvasSafeAreaSchema.optional(),
	});

const TemplateSlotBaseShape = {
	id: z.string().min(1),
	nodeId: z.string().min(1),
} as const;

export const TemplateTextSlotSchema = z.looseObject({
	...TemplateSlotBaseShape,
	kind: z.literal("text"),
});

export const TemplateImageSlotSchema = z.looseObject({
	...TemplateSlotBaseShape,
	kind: z.literal("image"),
});

export const TemplateLogoSlotSchema = z.looseObject({
	...TemplateSlotBaseShape,
	kind: z.literal("logo"),
});

export const TemplateFrameSlotSchema = z.looseObject({
	...TemplateSlotBaseShape,
	kind: z.literal("frame"),
});

export const TemplateColorSlotSchema = z.looseObject({
	...TemplateSlotBaseShape,
	kind: z.literal("color"),
	property: z.enum(["fill", "background", "stroke"]).optional(),
});

export const TemplateFontSlotSchema = z.looseObject({
	...TemplateSlotBaseShape,
	kind: z.literal("font"),
});

/** A discriminated union over the six slot kinds (FR-021), dispatched on `kind`. */
export const TemplateSlotSchema: z.ZodType<TemplateSlot> = z.discriminatedUnion(
	"kind",
	[
		TemplateTextSlotSchema,
		TemplateImageSlotSchema,
		TemplateLogoSlotSchema,
		TemplateFrameSlotSchema,
		TemplateColorSlotSchema,
		TemplateFontSlotSchema,
	],
);

export const TemplateVariableSchema: z.ZodType<TemplateVariable> =
	z.looseObject({
		id: z.string().min(1),
		label: z.string().min(1),
		slotId: z.string().min(1),
		defaultValue: z.string().optional(),
		required: z.boolean().optional(),
	});

export const TemplateLicenseSchema: z.ZodType<TemplateLicense> = z.looseObject({
	type: z.string().min(1),
	attribution: z.string().optional(),
	attributionRequired: z.boolean().optional(),
	redistributable: z.boolean().optional(),
	redistributionTerms: z.string().optional(),
});

export const TemplateSourceMetaSchema: z.ZodType<TemplateSourceMeta> =
	z.looseObject({
		author: z.string().optional(),
		sourceUrl: z.string().optional(),
	});

export const TemplateAssetAttributionSchema: z.ZodType<TemplateAssetAttribution> =
	z.looseObject({
		author: z.string().optional(),
		credit: z.string().optional(),
		sourceUrl: z.string().optional(),
	});

/**
 * Standalone — deliberately NOT nested under {@link CanvasTemplateDefinitionSchema}.
 * A marketplace/enterprise platform validates and stores this separately,
 * keyed by `templateId`, so it can never affect normal template validation.
 */
export const TemplateGovernancePolicySchema: z.ZodType<TemplateGovernancePolicy> =
	z.looseObject({
		templateId: z.string().min(1),
		approvalRequired: z.boolean().optional(),
		allowedOrgIds: z.array(z.string()).optional(),
		notes: z.string().optional(),
	});

/**
 * Validates a {@link CanvasTemplateDefinition} independently of normal Canvas
 * IR validation — template-only fields (`id`, `category`, `tags`, `variables`,
 * `editableSlots`, `lockedNodeIds`, `license`, `source`) are never accepted on
 * `document`, which is validated purely as a normal {@link CanvasIRSchema}.
 */
export const CanvasTemplateDefinitionSchema: z.ZodType<CanvasTemplateDefinition> =
	z.looseObject({
		id: z.string().min(1),
		version: z.string().min(1),
		title: z.string().min(1),
		category: z.string().min(1),
		tags: z.array(z.string()),
		previewAssetId: z.string().optional(),
		supportedSizes: z.array(CanvasSizePresetSchema),
		requiredAssets: z.array(z.string()).optional(),
		document: CanvasIRSchema,
		variables: z.array(TemplateVariableSchema),
		editableSlots: z.array(TemplateSlotSchema),
		lockedNodeIds: z.array(z.string()),
		license: TemplateLicenseSchema.optional(),
		source: TemplateSourceMetaSchema.optional(),
		assetAttributions: z
			.record(z.string(), TemplateAssetAttributionSchema)
			.optional(),
	});
