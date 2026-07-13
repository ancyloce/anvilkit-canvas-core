import { z } from "zod";
import { ImageFilterSchema } from "../ir/validators.js";
import type {
	BrandAsset,
	BrandColorToken,
	BrandFontToken,
	BrandImageStylePreset,
	BrandKitDefinition,
	BrandRule,
	BrandRuleKind,
	BrandToneMetadata,
	BrandTypographyPreset,
} from "./types.js";

export const BrandAssetSchema: z.ZodType<BrandAsset> = z.looseObject({
	id: z.string().min(1),
	name: z.string().min(1),
	uri: z.string().min(1),
	kind: z.enum(["logo", "image"]).optional(),
});

export const BrandColorTokenSchema: z.ZodType<BrandColorToken> = z.looseObject({
	id: z.string().optional(),
	name: z.string().min(1),
	value: z.string().min(1),
});

export const BrandFontTokenSchema: z.ZodType<BrandFontToken> = z.looseObject({
	id: z.string().optional(),
	name: z.string().min(1),
	family: z.string().min(1),
});

export const BrandTypographyPresetSchema: z.ZodType<BrandTypographyPreset> =
	z.looseObject({
		id: z.string().min(1),
		name: z.string().min(1),
		fontId: z.string().optional(),
		fontSize: z.number().positive().optional(),
		fontWeight: z.string().optional(),
		lineHeight: z.number().positive().optional(),
	});

export const BrandImageStylePresetSchema: z.ZodType<BrandImageStylePreset> =
	z.looseObject({
		id: z.string().min(1),
		name: z.string().min(1),
		filters: z.array(ImageFilterSchema).optional(),
	});

export const BrandToneMetadataSchema: z.ZodType<BrandToneMetadata> =
	z.looseObject({
		voice: z.string().optional(),
		keywords: z.array(z.string()).optional(),
	});

const BRAND_RULE_KINDS = [
	"allowed-color",
	"forbidden-color",
	"allowed-font",
	"forbidden-font",
] as const satisfies readonly BrandRuleKind[];

export const BrandRuleSchema: z.ZodType<BrandRule> = z.looseObject({
	id: z.string().min(1),
	kind: z.enum(BRAND_RULE_KINDS),
	value: z.string().min(1),
});

export const BrandKitDefinitionSchema: z.ZodType<BrandKitDefinition> =
	z.looseObject({
		id: z.string().min(1),
		name: z.string().min(1),
		logos: z.array(BrandAssetSchema),
		colors: z.array(BrandColorTokenSchema),
		fonts: z.array(BrandFontTokenSchema),
		typography: z.array(BrandTypographyPresetSchema),
		imageStylePresets: z.array(BrandImageStylePresetSchema).optional(),
		toneOfVoice: BrandToneMetadataSchema.optional(),
		rules: z.array(BrandRuleSchema),
		defaultExportPresets: z.array(z.string()).optional(),
	});
