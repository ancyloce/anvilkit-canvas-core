import type { CanvasExportFormat } from "./export/types.js";

/** Release maturity exposed to hosts and product documentation. */
export type CanvasCapabilityMaturity = "experimental" | "beta" | "stable";

/** Program priority used by release gates and rollback policy. */
export type CanvasCapabilityPriority = "P0" | "P1";

/** Teams that own a Canvas capability's implementation and release evidence. */
export type CanvasCapabilityOwner =
	| "ai"
	| "canvas-core"
	| "canvas-editor"
	| "collaboration";

/** Host seams that can be required before a capability is available. */
export type CanvasProviderRequirementId =
	| "ai-design-provider"
	| "ai-image-provider"
	| "asset-picker"
	| "asset-uploader"
	| "brand-policy-provider"
	| "collaboration-provider"
	| "comment-provider"
	| "component-provider"
	| "font-provider"
	| "persistence-adapter"
	| "recovery-adapter"
	| "template-provider";

/** Stable release-level capability IDs. These are not document capability IDs. */
export type CanvasReleaseCapabilityId =
	| "canvas.ai.design"
	| "canvas.ai.image"
	| "canvas.assets.hosted"
	| "canvas.assets.local"
	| "canvas.auto-layout"
	| "canvas.brand-governance"
	| "canvas.collaboration"
	| "canvas.comments"
	| "canvas.components.external"
	| "canvas.components.local"
	| "canvas.components.variants"
	| "canvas.editing"
	| "canvas.elements"
	| "canvas.export.high-resolution"
	| "canvas.export.json"
	| "canvas.export.pdf"
	| "canvas.export.pdf-print"
	| "canvas.export.raster"
	| "canvas.export.svg"
	| "canvas.persistence"
	| "canvas.recovery"
	| "canvas.smart-resize"
	| "canvas.templates"
	| "canvas.typography";

/** Stable host-configured feature flag IDs. */
export type CanvasFeatureFlagId =
	| "canvas.feature.ai-design"
	| "canvas.feature.ai-image"
	| "canvas.feature.auto-layout"
	| "canvas.feature.brand-governance"
	| "canvas.feature.collaboration"
	| "canvas.feature.comments"
	| "canvas.feature.editing"
	| "canvas.feature.elements"
	| "canvas.feature.export-high-resolution"
	| "canvas.feature.export-json"
	| "canvas.feature.export-pdf"
	| "canvas.feature.export-pdf-print"
	| "canvas.feature.export-raster"
	| "canvas.feature.export-svg"
	| "canvas.feature.external-components"
	| "canvas.feature.hosted-assets"
	| "canvas.feature.local-assets"
	| "canvas.feature.local-components"
	| "canvas.feature.persistence"
	| "canvas.feature.recovery"
	| "canvas.feature.smart-resize"
	| "canvas.feature.templates"
	| "canvas.feature.typography"
	| "canvas.feature.component-variants";

export interface CanvasProviderRequirement {
	readonly id: CanvasProviderRequirementId;
	/** Why the provider is needed, suitable for generated integration docs. */
	readonly description: string;
}

export interface CanvasCapabilityFeatureFlag {
	readonly id: CanvasFeatureFlagId;
	/** The zero-configuration default. Provider requirements still apply. */
	readonly defaultEnabled: boolean;
}

/** One executable row in the Canvas release capability registry. */
export interface CanvasReleaseCapability {
	readonly id: CanvasReleaseCapabilityId;
	readonly owner: CanvasCapabilityOwner;
	readonly priority: CanvasCapabilityPriority;
	readonly maturity: CanvasCapabilityMaturity;
	readonly publicDescription: string;
	readonly featureFlag: CanvasCapabilityFeatureFlag;
	/** Other release capabilities that must be enabled first. */
	readonly dependencies: readonly CanvasReleaseCapabilityId[];
	/** Empty means the capability works with zero host provider wiring. */
	readonly providerRequirements: readonly CanvasProviderRequirement[];
	/** Export formats directly produced or affected by this capability. */
	readonly supportedFormats: readonly CanvasExportFormat[];
}

/**
 * Executable source of truth for the user-visible Canvas release surface.
 *
 * This registry deliberately describes product/release capabilities, not the
 * `CanvasIR.requiredCapabilities` wire-format vocabulary. A host can use it to
 * generate release notes, feature controls, and integration requirements
 * without teaching those consumers a second capability list.
 */
export const CANVAS_RELEASE_CAPABILITIES = [
	{
		id: "canvas.editing",
		owner: "canvas-editor",
		priority: "P0",
		maturity: "beta",
		publicDescription:
			"Create and edit multi-page static Canvas documents with undo and redo.",
		featureFlag: { id: "canvas.feature.editing", defaultEnabled: true },
		dependencies: [],
		providerRequirements: [],
		supportedFormats: [],
	},
	{
		id: "canvas.persistence",
		owner: "canvas-editor",
		priority: "P0",
		maturity: "beta",
		publicDescription: "Load and save Canvas documents through a host adapter.",
		featureFlag: { id: "canvas.feature.persistence", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [
			{
				id: "persistence-adapter",
				description: "Loads and saves the current document.",
			},
		],
		supportedFormats: ["json"],
	},
	{
		id: "canvas.recovery",
		owner: "canvas-editor",
		priority: "P0",
		maturity: "beta",
		publicDescription:
			"Recover a newer local draft after an interrupted session.",
		featureFlag: { id: "canvas.feature.recovery", defaultEnabled: true },
		dependencies: ["canvas.persistence"],
		providerRequirements: [
			{
				id: "recovery-adapter",
				description:
					"Stores, loads, and clears recoverable document snapshots.",
			},
		],
		supportedFormats: ["json"],
	},
	{
		id: "canvas.assets.local",
		owner: "canvas-editor",
		priority: "P0",
		maturity: "beta",
		publicDescription:
			"Ingest images into browser-local storage when no host asset service is configured.",
		featureFlag: { id: "canvas.feature.local-assets", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
	{
		id: "canvas.assets.hosted",
		owner: "canvas-editor",
		priority: "P0",
		maturity: "beta",
		publicDescription:
			"Pick and upload portable assets through host-provided services.",
		featureFlag: { id: "canvas.feature.hosted-assets", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [
			{
				id: "asset-picker",
				description: "Selects an existing hosted asset.",
			},
			{
				id: "asset-uploader",
				description:
					"Uploads new asset bytes and returns a portable reference.",
			},
		],
		supportedFormats: [
			"png",
			"jpeg",
			"webp",
			"svg",
			"pdf",
			"pdf-print",
			"json",
		],
	},
	{
		id: "canvas.elements",
		owner: "canvas-editor",
		priority: "P1",
		maturity: "beta",
		publicDescription: "Browse and insert the built-in vector element catalog.",
		featureFlag: { id: "canvas.feature.elements", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
	{
		id: "canvas.templates",
		owner: "canvas-editor",
		priority: "P1",
		maturity: "beta",
		publicDescription:
			"Create pages or documents from a host template catalog.",
		featureFlag: { id: "canvas.feature.templates", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [
			{
				id: "template-provider",
				description: "Lists and resolves template documents.",
			},
		],
		supportedFormats: ["json"],
	},
	{
		id: "canvas.typography",
		owner: "canvas-editor",
		priority: "P1",
		maturity: "beta",
		publicDescription:
			"Author rich text and resolve host or built-in font catalog entries.",
		featureFlag: { id: "canvas.feature.typography", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [
			{
				id: "font-provider",
				description:
					"Optional for self-hosted font bytes and portable export embedding.",
			},
		],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
	{
		id: "canvas.auto-layout",
		owner: "canvas-editor",
		priority: "P0",
		maturity: "beta",
		publicDescription:
			"Create and edit responsive stack and frame layout intent.",
		featureFlag: { id: "canvas.feature.auto-layout", defaultEnabled: false },
		dependencies: ["canvas.editing"],
		providerRequirements: [],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
	{
		id: "canvas.components.local",
		owner: "canvas-editor",
		priority: "P1",
		maturity: "beta",
		publicDescription: "Create and reuse components stored inside a document.",
		featureFlag: {
			id: "canvas.feature.local-components",
			defaultEnabled: false,
		},
		dependencies: ["canvas.editing"],
		providerRequirements: [],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
	{
		id: "canvas.components.external",
		owner: "canvas-editor",
		priority: "P1",
		maturity: "experimental",
		publicDescription:
			"Browse and insert verified components from an external library.",
		featureFlag: {
			id: "canvas.feature.external-components",
			defaultEnabled: false,
		},
		dependencies: ["canvas.components.local"],
		providerRequirements: [
			{
				id: "component-provider",
				description:
					"Searches, resolves, and updates external component snapshots.",
			},
		],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
	{
		id: "canvas.components.variants",
		owner: "canvas-editor",
		priority: "P1",
		maturity: "experimental",
		publicDescription: "Select and preserve component variants and overrides.",
		featureFlag: {
			id: "canvas.feature.component-variants",
			defaultEnabled: false,
		},
		dependencies: ["canvas.components.local"],
		providerRequirements: [],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
	{
		id: "canvas.brand-governance",
		owner: "canvas-core",
		priority: "P1",
		maturity: "beta",
		publicDescription:
			"Evaluate brand policy and block or warn on non-compliant edits and exports.",
		featureFlag: {
			id: "canvas.feature.brand-governance",
			defaultEnabled: true,
		},
		dependencies: ["canvas.editing"],
		providerRequirements: [
			{
				id: "brand-policy-provider",
				description:
					"Supplies the effective policy and host capability snapshot.",
			},
		],
		supportedFormats: [
			"png",
			"jpeg",
			"webp",
			"svg",
			"pdf",
			"pdf-print",
			"json",
		],
	},
	{
		id: "canvas.export.raster",
		owner: "canvas-editor",
		priority: "P0",
		maturity: "beta",
		publicDescription: "Export Canvas pages as PNG, JPEG, or WebP images.",
		featureFlag: { id: "canvas.feature.export-raster", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [],
		supportedFormats: ["png", "jpeg", "webp"],
	},
	{
		id: "canvas.export.svg",
		owner: "canvas-core",
		priority: "P0",
		maturity: "beta",
		publicDescription: "Export Canvas pages as structured SVG.",
		featureFlag: { id: "canvas.feature.export-svg", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [],
		supportedFormats: ["svg"],
	},
	{
		id: "canvas.export.pdf",
		owner: "canvas-core",
		priority: "P0",
		maturity: "beta",
		publicDescription: "Export a multi-page Canvas document as a raster PDF.",
		featureFlag: { id: "canvas.feature.export-pdf", defaultEnabled: true },
		dependencies: ["canvas.export.raster"],
		providerRequirements: [],
		supportedFormats: ["pdf"],
	},
	{
		id: "canvas.export.pdf-print",
		owner: "canvas-core",
		priority: "P0",
		maturity: "beta",
		publicDescription:
			"Prepare a raster PDF with print-safety metadata and diagnostics.",
		featureFlag: {
			id: "canvas.feature.export-pdf-print",
			defaultEnabled: true,
		},
		dependencies: ["canvas.export.pdf"],
		providerRequirements: [],
		supportedFormats: ["pdf-print"],
	},
	{
		id: "canvas.export.json",
		owner: "canvas-core",
		priority: "P0",
		maturity: "beta",
		publicDescription: "Export the Canvas document as lossless JSON.",
		featureFlag: { id: "canvas.feature.export-json", defaultEnabled: true },
		dependencies: ["canvas.editing"],
		providerRequirements: [],
		supportedFormats: ["json"],
	},
	{
		id: "canvas.export.high-resolution",
		owner: "canvas-editor",
		priority: "P0",
		maturity: "experimental",
		publicDescription:
			"Export raster output above the standard resolution tier.",
		featureFlag: {
			id: "canvas.feature.export-high-resolution",
			defaultEnabled: true,
		},
		dependencies: ["canvas.export.raster"],
		providerRequirements: [],
		supportedFormats: ["png", "jpeg", "webp", "pdf", "pdf-print"],
	},
	{
		id: "canvas.collaboration",
		owner: "collaboration",
		priority: "P0",
		maturity: "experimental",
		publicDescription:
			"Synchronize Canvas changes and presence through a collaboration provider.",
		featureFlag: {
			id: "canvas.feature.collaboration",
			defaultEnabled: false,
		},
		dependencies: ["canvas.persistence"],
		providerRequirements: [
			{
				id: "collaboration-provider",
				description: "Transports document updates and ephemeral presence.",
			},
		],
		supportedFormats: ["json"],
	},
	{
		id: "canvas.comments",
		owner: "collaboration",
		priority: "P0",
		maturity: "experimental",
		publicDescription:
			"Create and resolve comment threads anchored to Canvas nodes.",
		featureFlag: { id: "canvas.feature.comments", defaultEnabled: false },
		dependencies: ["canvas.collaboration"],
		providerRequirements: [
			{
				id: "comment-provider",
				description:
					"Persists threads, permissions, mentions, and resolution state.",
			},
		],
		supportedFormats: [],
	},
	{
		id: "canvas.ai.image",
		owner: "ai",
		priority: "P1",
		maturity: "experimental",
		publicDescription:
			"Run cancellable AI image jobs and apply validated results to the document.",
		featureFlag: { id: "canvas.feature.ai-image", defaultEnabled: false },
		dependencies: ["canvas.assets.hosted"],
		providerRequirements: [
			{
				id: "ai-image-provider",
				description: "Starts image jobs and returns hosted result assets.",
			},
		],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
	{
		id: "canvas.ai.design",
		owner: "ai",
		priority: "P1",
		maturity: "experimental",
		publicDescription:
			"Generate validated candidate Canvas documents for preview and atomic apply.",
		featureFlag: { id: "canvas.feature.ai-design", defaultEnabled: false },
		dependencies: ["canvas.ai.image", "canvas.templates"],
		providerRequirements: [
			{
				id: "ai-design-provider",
				description: "Produces candidate Canvas IR and terminal job status.",
			},
		],
		supportedFormats: ["json"],
	},
	{
		id: "canvas.smart-resize",
		owner: "canvas-editor",
		priority: "P1",
		maturity: "beta",
		publicDescription:
			"Create deterministic size variants from the active Canvas page.",
		featureFlag: { id: "canvas.feature.smart-resize", defaultEnabled: true },
		dependencies: ["canvas.editing", "canvas.auto-layout"],
		providerRequirements: [],
		supportedFormats: ["png", "jpeg", "webp", "svg", "pdf", "json"],
	},
] as const satisfies readonly CanvasReleaseCapability[];

export const CANVAS_RELEASE_CAPABILITY_IDS = CANVAS_RELEASE_CAPABILITIES.map(
	(capability) => capability.id,
) as readonly CanvasReleaseCapabilityId[];

export const CANVAS_RELEASE_FEATURE_FLAG_DEFAULTS = Object.freeze(
	Object.fromEntries(
		CANVAS_RELEASE_CAPABILITIES.map(({ featureFlag }) => [
			featureFlag.id,
			featureFlag.defaultEnabled,
		]),
	) as Record<CanvasFeatureFlagId, boolean>,
);

const CAPABILITY_BY_ID = new Map<
	CanvasReleaseCapabilityId,
	CanvasReleaseCapability
>(CANVAS_RELEASE_CAPABILITIES.map((capability) => [capability.id, capability]));

/** Resolve one registry row by stable ID. */
export function getCanvasReleaseCapability(
	id: CanvasReleaseCapabilityId,
): CanvasReleaseCapability {
	const capability = CAPABILITY_BY_ID.get(id);
	if (!capability) {
		throw new Error(`Unknown Canvas release capability: ${id}`);
	}
	return capability;
}
