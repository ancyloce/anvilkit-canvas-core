import { describe, expect, it } from "vitest";
import type { BrandKitDefinition } from "../types.js";
import {
	BrandAssetSchema,
	BrandColorTokenSchema,
	BrandFontTokenSchema,
	BrandKitDefinitionSchema,
	BrandRuleSchema,
	BrandTypographyPresetSchema,
} from "../validators.js";

function makeMinimalKit(): BrandKitDefinition {
	return {
		id: "kit1",
		name: "Acme",
		logos: [],
		colors: [],
		fonts: [],
		typography: [],
		rules: [],
	};
}

describe("BrandAssetSchema", () => {
	it("accepts a logo asset", () => {
		const asset = {
			id: "logo1",
			name: "Wordmark",
			uri: "asset://logo1",
			kind: "logo",
		};
		expect(BrandAssetSchema.safeParse(asset).success).toBe(true);
	});

	it("rejects an asset missing a uri", () => {
		expect(
			BrandAssetSchema.safeParse({ id: "logo1", name: "Wordmark" }).success,
		).toBe(false);
	});
});

describe("BrandColorTokenSchema", () => {
	it("accepts a color token without an id (structurally matches editor's BrandColor)", () => {
		expect(
			BrandColorTokenSchema.safeParse({ name: "Primary", value: "#2563eb" })
				.success,
		).toBe(true);
	});
});

describe("BrandFontTokenSchema", () => {
	it("accepts a font token", () => {
		expect(
			BrandFontTokenSchema.safeParse({ name: "Body", family: "Inter" }).success,
		).toBe(true);
	});
});

describe("BrandTypographyPresetSchema", () => {
	it("accepts a preset referencing a font id", () => {
		const preset = {
			id: "heading",
			name: "Heading",
			fontId: "font1",
			fontSize: 32,
			fontWeight: "700",
			lineHeight: 1.2,
		};
		expect(BrandTypographyPresetSchema.safeParse(preset).success).toBe(true);
	});
});

describe("BrandRuleSchema", () => {
	it("accepts each of the four rule kinds", () => {
		for (const kind of [
			"allowed-color",
			"forbidden-color",
			"allowed-font",
			"forbidden-font",
		] as const) {
			expect(
				BrandRuleSchema.safeParse({ id: `rule-${kind}`, kind, value: "x" })
					.success,
			).toBe(true);
		}
	});

	it("rejects an unknown rule kind", () => {
		expect(
			BrandRuleSchema.safeParse({ id: "r1", kind: "banned-color", value: "x" })
				.success,
		).toBe(false);
	});
});

describe("BrandKitDefinitionSchema", () => {
	it("validates a minimal kit", () => {
		expect(BrandKitDefinitionSchema.safeParse(makeMinimalKit()).success).toBe(
			true,
		);
	});

	it("validates a kit carrying every optional field", () => {
		const full: BrandKitDefinition = {
			...makeMinimalKit(),
			logos: [
				{ id: "logo1", name: "Wordmark", uri: "asset://logo1", kind: "logo" },
			],
			colors: [{ id: "c1", name: "Primary", value: "#2563eb" }],
			fonts: [{ id: "f1", name: "Body", family: "Inter" }],
			typography: [
				{ id: "heading", name: "Heading", fontId: "f1", fontSize: 32 },
			],
			imageStylePresets: [
				{ id: "warm", name: "Warm", filters: [{ kind: "sepia" }] },
			],
			toneOfVoice: { voice: "friendly", keywords: ["approachable"] },
			rules: [{ id: "r1", kind: "forbidden-color", value: "#ff0000" }],
			defaultExportPresets: ["png"],
		};
		expect(BrandKitDefinitionSchema.safeParse(full).success).toBe(true);
	});

	it("rejects a kit missing a required array field (e.g. rules)", () => {
		const { rules: _omit, ...withoutRules } = makeMinimalKit();
		expect(BrandKitDefinitionSchema.safeParse(withoutRules).success).toBe(
			false,
		);
	});
});
