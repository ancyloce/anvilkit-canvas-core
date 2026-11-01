/** Versioned reference matrix for PLAN-0039 E0-T2. */
export const CANVAS_REFERENCE_SUITE_VERSION = "1.0.0" as const;

export type CanvasReferenceEnvironmentTier =
	| "desktop-primary"
	| "desktop-low-tier"
	| "headless-core"
	| "touch-primary";

export interface CanvasReferenceEnvironment {
	readonly id: string;
	readonly version: number;
	readonly tier: CanvasReferenceEnvironmentTier;
	readonly device: string;
	readonly hardware: string;
	readonly operatingSystem: string;
	readonly browsers: readonly string[];
	readonly execution: "automated" | "manual";
}

/**
 * Product and harness environments selected for the Canvas release program.
 * Exact browser binaries in automation are supplied by Playwright 1.61.0.
 */
export const CANVAS_REFERENCE_ENVIRONMENTS = [
	{
		id: "canvas-headless-core-wsl2-v1",
		version: 1,
		tier: "headless-core",
		device: "Recorded Canvas Core resolver host",
		hardware: "Intel Core i5-10300H, 8 logical cores, 23.5 GB RAM",
		operatingSystem: "Linux x64, Microsoft WSL2 kernel family",
		browsers: [],
		execution: "automated",
	},
	{
		id: "canvas-desktop-primary-v1",
		version: 1,
		tier: "desktop-primary",
		device: "Four-core x64 laptop class",
		hardware: "4 physical cores, 16 GB RAM, integrated GPU, DPR 1 and 2",
		operatingSystem: "Windows 11 24H2",
		browsers: [
			"Chromium (Playwright 1.61.0)",
			"Firefox (Playwright 1.61.0)",
			"WebKit (Playwright 1.61.0)",
		],
		execution: "automated",
	},
	{
		id: "canvas-desktop-low-tier-v1",
		version: 1,
		tier: "desktop-low-tier",
		device: "Low-tier dual-core x64 laptop class",
		hardware: "2 physical cores, 8 GB RAM, integrated GPU, DPR 1",
		operatingSystem: "Windows 11 24H2",
		browsers: ["Chromium", "Firefox"],
		execution: "manual",
	},
	{
		id: "canvas-touch-primary-v1",
		version: 1,
		tier: "touch-primary",
		device: "10.9-inch iPad (10th-generation class)",
		hardware: "A14-class SoC, 4 GB RAM, 820x1180 CSS viewport, DPR 2",
		operatingSystem: "iPadOS 18",
		browsers: ["Mobile Safari 18"],
		execution: "manual",
	},
] as const satisfies readonly CanvasReferenceEnvironment[];

export type CanvasReferenceDocumentProfile =
	| "balanced"
	| "component-heavy"
	| "image-heavy"
	| "layout"
	| "text-heavy";

export interface CanvasReferenceDocumentFixture {
	readonly id: string;
	readonly version: number;
	readonly profile: CanvasReferenceDocumentProfile;
	readonly scale: string;
	readonly source: string;
	readonly description: string;
}

/**
 * Named documents used by current benchmarks and required by the next browser
 * performance harness. The `source` is executable, not a prose-only fixture.
 */
export const CANVAS_REFERENCE_DOCUMENT_FIXTURES = [
	{
		id: "canvas-balanced-100-v1",
		version: 1,
		profile: "balanced",
		scale: "100 content nodes",
		source: "bench/fixtures/reference-documents.ts",
		description: "Small mixed document used for smoke and baseline overhead.",
	},
	{
		id: "canvas-balanced-1000-v1",
		version: 1,
		profile: "balanced",
		scale: "1,000 content nodes",
		source: "bench/fixtures/reference-documents.ts",
		description: "Release 1 target-size mixed document.",
	},
	{
		id: "canvas-balanced-5000-v1",
		version: 1,
		profile: "balanced",
		scale: "5,000 content nodes",
		source: "bench/fixtures/reference-documents.ts",
		description: "Large-document degraded-mode target.",
	},
	{
		id: "canvas-text-1000-v1",
		version: 1,
		profile: "text-heavy",
		scale: "1,000 text nodes",
		source: "bench/fixtures/reference-documents.ts",
		description: "Text measurement and typography stress document.",
	},
	{
		id: "canvas-image-1000-v1",
		version: 1,
		profile: "image-heavy",
		scale: "1,000 image nodes sharing one deterministic asset",
		source: "bench/fixtures/reference-documents.ts",
		description: "Image decode, cache, thumbnail, and export stress document.",
	},
	{
		id: "canvas-components-1000-v1",
		version: 1,
		profile: "component-heavy",
		scale: "1,000 component instances",
		source: "bench/fixtures/reference-documents.ts",
		description: "Component expansion and invalidation stress document.",
	},
	{
		id: "canvas-layout-mixed-1000-v1",
		version: 1,
		profile: "layout",
		scale: "1,000 nodes, 30 percent frames, depth at most 10",
		source: "bench/layout-resolve.bench.ts",
		description: "Cold and warm Auto Layout resolver workload.",
	},
	{
		id: "canvas-layout-text-100-v1",
		version: 1,
		profile: "text-heavy",
		scale: "100 text nodes sharing 20 measurement keys",
		source: "bench/layout-resolve.bench.ts",
		description: "Text measurement cache workload.",
	},
	{
		id: "canvas-layout-hug-depth-3-v1",
		version: 1,
		profile: "layout",
		scale: "Three nested Hug containers and one text leaf",
		source: "bench/layout-resolve.bench.ts",
		description: "Localized invalidation through a three-level Hug chain.",
	},
] as const satisfies readonly CanvasReferenceDocumentFixture[];

export type CanvasReferenceDocumentFixtureId =
	(typeof CANVAS_REFERENCE_DOCUMENT_FIXTURES)[number]["id"];

export function canvasReferenceSuiteLabel(): string {
	return `canvas-reference-suite@${CANVAS_REFERENCE_SUITE_VERSION}`;
}

export function canvasReferenceFixtureLabel(
	id: CanvasReferenceDocumentFixtureId,
): string {
	return `${id} (suite ${CANVAS_REFERENCE_SUITE_VERSION})`;
}
