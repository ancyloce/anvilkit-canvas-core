import type { ImageFilter } from "../ir/types.js";

/** A brand logo or reference image asset. */
export interface BrandAsset {
	id: string;
	name: string;
	uri: string;
	kind?: "logo" | "image";
}

/**
 * A named brand color. Structurally identical to `@anvilkit/canvas-editor`'s
 * pre-existing `BrandColor` (`{id?, name, value}`) by design, so the editor's
 * mapping from this canonical shape is a straight pass-through, not a reshape.
 */
export interface BrandColorToken {
	id?: string;
	name: string;
	value: string;
}

/** A named brand font family. */
export interface BrandFontToken {
	id?: string;
	name: string;
	family: string;
}

/** A named typography preset (heading, body, caption, …) built from brand fonts. */
export interface BrandTypographyPreset {
	id: string;
	name: string;
	/** References a {@link BrandFontToken.id}, when the preset is tied to one. */
	fontId?: string;
	fontSize?: number;
	fontWeight?: string;
	lineHeight?: number;
}

/** A named image treatment (filter stack) brand-approved for photo/image content. */
export interface BrandImageStylePreset {
	id: string;
	name: string;
	filters?: ImageFilter[];
}

/** Free-form brand voice/tone guidance, for AI copy generation (M4) to consume. */
export interface BrandToneMetadata {
	voice?: string;
	keywords?: string[];
}

/** The four rule kinds a brand kit can declare for compliance checking (canvas-m2-006). */
export type BrandRuleKind =
	| "allowed-color"
	| "forbidden-color"
	| "allowed-font"
	| "forbidden-font";

export interface BrandRule {
	id: string;
	kind: BrandRuleKind;
	/** A color value (for color rules) or font family/id (for font rules). */
	value: string;
}

/**
 * The canonical Brand Kit contract (PRD FR-031, §12.6).
 *
 * Lives in `canvas-core` rather than `@anvilkit/core` or a shared schema
 * package (PRD open question 1, §18): Canvas IR already references brand
 * *tokens* (`BrandTokenRef`, canvas-m1-012), and this contract's `rules`
 * (allowed/forbidden colors and fonts) are canvas-specific validation
 * concerns with no meaning outside the canvas domain.
 *
 * Kept strictly separate from Canvas IR — a document references brand tokens
 * by id only (`BrandTokenRef`); it never embeds a `BrandKitDefinition`.
 */
export interface BrandKitDefinition {
	id: string;
	name: string;
	logos: BrandAsset[];
	colors: BrandColorToken[];
	fonts: BrandFontToken[];
	typography: BrandTypographyPreset[];
	imageStylePresets?: BrandImageStylePreset[];
	toneOfVoice?: BrandToneMetadata;
	rules: BrandRule[];
	defaultExportPresets?: string[];
}
