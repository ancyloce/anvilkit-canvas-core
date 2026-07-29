import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
	createText,
} from "../../../ir/builders.js";
import { insertNode } from "../../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../../ir/types.js";
import type {
	MeasuredText,
	TextMeasureRequest,
} from "../../../text-contracts.js";
import type { CanvasLayoutResolveOptions } from "../../types.js";

/**
 * @file T-M5-01 — the shared contract-fixture corpus (TS-57): the seven PRD
 * §15 integration fixtures plus the three Review-0016 additions. Every
 * consumer harness (headless resolver, SVG serialization — this package;
 * editor renderer and raster/PDF export — `@anvilkit/canvas-editor`, which
 * MIRRORS the representative documents because test files cannot cross the
 * package boundary) runs against these documents. A fixture that passes only
 * in the resolver is not covered.
 *
 * Determinism discipline (matches `svg-golden.test.ts`): fixed ids, fixed
 * timestamps via `now`, literal geometry, no randomness, no Date.now(). All
 * rect nodes are plain solid-fill/radius-free so every emitted `<rect`
 * element in the SVG maps 1:1 to a rect node in flow order (frames here
 * carry no background and no clip, so they emit no box element of their own).
 */

export const CONTRACT_FIXED_TS = "2026-07-28T00:00:00.000Z";

/**
 * The deterministic measurement provider every consumer must share: width is
 * 10 units per character, height a flat 24 — same shape the resolver unit
 * suite uses, so Hug results are directly comparable across suites.
 */
export function contractMeasureText(request: TextMeasureRequest): MeasuredText {
	let chars = 0;
	for (const paragraph of request.paragraphs) {
		for (const span of paragraph.spans) chars += span.text.length;
	}
	return { lines: [], width: chars * 10, height: 24 };
}

export function contractLayout(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		version: 1,
		direction: "horizontal",
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		gap: 0,
		primaryAlign: "start",
		crossAlign: "start",
		...overrides,
	};
}

function docOf(children: CanvasNode[], extra?: Partial<CanvasIR>): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({
		id: "contract-doc",
		title: "contract",
		pages: [page],
		now: () => CONTRACT_FIXED_TS,
	});
	for (const child of children) {
		ir = insertNode(ir, { parentId: page.root.id, node: child });
	}
	return extra ? ({ ...ir, ...extra } as CanvasIR) : ir;
}

function frameWith(
	id: string,
	children: CanvasNode[],
	layout: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
): CanvasNode {
	return {
		...createFrame({ id, bounds: { width: 200, height: 100 } }),
		autoLayout: contractLayout(layout),
		children,
		...overrides,
	} as CanvasNode;
}

function rect(
	id: string,
	width: number,
	height: number,
	overrides: Record<string, unknown> = {},
): CanvasNode {
	return {
		...createRect({ id, bounds: { width, height }, fill: "#334455" }),
		...overrides,
	} as CanvasNode;
}

function text(id: string, content: string): CanvasNode {
	// Stored bounds match the deterministic measurer (10/char × 24) so the
	// document is self-consistent even before resolution.
	return createText({
		id,
		text: content,
		bounds: { width: content.length * 10, height: 24 },
	}) as CanvasNode;
}

export interface ContractFixture {
	id: string;
	title: string;
	/** What the fixture exercises and which acceptance criterion it pins. */
	notes: string;
	build: () => { ir: CanvasIR; options: CanvasLayoutResolveOptions };
}

const MEASUREMENT: CanvasLayoutResolveOptions = {
	measurement: { measureText: contractMeasureText },
};

/** 1 — CTA button with Hug text (PRD §15.1). */
const ctaHugButton: ContractFixture = {
	id: "cta-hug-button",
	title: "CTA button with Hug text",
	notes:
		"Hug-both-axes frame sized by measured text plus padding/gap; the icon rect's flow x proves the measured width (AC-002, AC-014).",
	build: () => ({
		ir: docOf([
			frameWith(
				"cta",
				[text("cta-label", "Get started"), rect("cta-icon", 16, 16)],
				{
					gap: 8,
					padding: { top: 12, right: 16, bottom: 12, left: 16 },
					crossAlign: "center",
				},
				{ layoutItem: { widthSizing: "hug", heightSizing: "hug" } },
			),
		]),
		options: MEASUREMENT,
	}),
};

/** 2 — horizontal logo-and-copy row (PRD §15.2). */
const logoCopyRow: ContractFixture = {
	id: "logo-copy-row",
	title: "Horizontal logo-and-copy row",
	notes:
		"Fixed logo, Hug copy, trailing badge: the badge's flow x moves with the measured copy width (AC-002).",
	build: () => ({
		ir: docOf([
			frameWith(
				"row",
				[
					rect("logo", 64, 64),
					text("copy", "Spring launch"),
					rect("badge", 24, 24),
				],
				{ gap: 12, padding: { top: 8, right: 8, bottom: 8, left: 8 } },
				{ bounds: { width: 400, height: 80 } },
			),
		]),
		options: MEASUREMENT,
	}),
};

/** 3 — nested product card (PRD §15.3). */
const nestedProductCard: ContractFixture = {
	id: "nested-product-card",
	title: "Nested product card",
	notes:
		"Vertical card containing horizontal Auto Layout rows — nested resolution with Hug rows inside a fixed-width column (AC-003).",
	build: () => ({
		ir: docOf([
			frameWith(
				"card",
				[
					frameWith(
						"card-header",
						[rect("avatar", 32, 32), rect("title", 120, 16)],
						{ gap: 8, crossAlign: "center" },
						{
							bounds: { width: 236, height: 40 },
							layoutItem: { heightSizing: "hug" },
						},
					),
					rect("hero", 236, 120),
					frameWith(
						"card-footer",
						[rect("price", 60, 20), rect("cta", 80, 28)],
						{ gap: 10, primaryAlign: "end", crossAlign: "center" },
						{
							bounds: { width: 236, height: 36 },
							layoutItem: { heightSizing: "hug" },
						},
					),
				],
				{
					direction: "vertical",
					gap: 12,
					padding: { top: 12, right: 12, bottom: 12, left: 12 },
				},
				{
					bounds: { width: 260, height: 240 },
					layoutItem: { heightSizing: "hug" },
				},
			),
		]),
		options: MEASUREMENT,
	}),
};

/** 4 — pricing-card row with Fill child (PRD §15.4). */
const pricingRowFill: ContractFixture = {
	id: "pricing-row-fill",
	title: "Pricing row with Fill child",
	notes:
		"Fixed + Fill + Fixed: the Fill child absorbs exactly the remaining primary space (AC-004).",
	build: () => ({
		ir: docOf([
			frameWith(
				"pricing",
				[
					rect("plan-a", 60, 40),
					rect("plan-b", 40, 40, {
						layoutItem: { widthSizing: "fill" },
					}),
					rect("plan-c", 60, 40),
				],
				{ gap: 10, padding: { top: 10, right: 10, bottom: 10, left: 10 } },
				{ bounds: { width: 300, height: 60 } },
			),
		]),
		options: {},
	}),
};

/** 5 — absolute badge overlay (PRD §15.5). */
const absoluteBadge: ContractFixture = {
	id: "absolute-badge",
	title: "Absolute badge overlay",
	notes:
		"An Absolute child pinned from the frame's border-box origin overlapping the corner; flow children are unaffected by it (AC-005, §7.6).",
	build: () => ({
		ir: docOf([
			frameWith(
				"banner",
				[
					rect("slot-a", 50, 30),
					rect("slot-b", 50, 30),
					rect("overlay-badge", 24, 24, {
						transform: { x: 176, y: -12 },
						layoutItem: { positioning: "absolute" },
					}),
				],
				{ gap: 8, padding: { top: 8, right: 8, bottom: 8, left: 8 } },
			),
		]),
		options: {},
	}),
};

/** 6 — 30% longer localized copy (PRD §15.6). */
const localizedCopy: ContractFixture = {
	id: "localized-copy-longer",
	title: "30% longer localized copy",
	notes:
		"Same row as fixture 2 with longer copy on a Hug-width row: the row grows and the badge shifts instead of overlapping (AC-014).",
	build: () => ({
		ir: docOf([
			frameWith(
				"row-l10n",
				[
					rect("logo-l10n", 64, 64),
					text("copy-l10n", "Frühjahrs-Markteinführung"),
					rect("badge-l10n", 24, 24),
				],
				{ gap: 12, padding: { top: 8, right: 8, bottom: 8, left: 8 } },
				{
					bounds: { width: 400, height: 80 },
					layoutItem: { widthSizing: "hug" },
				},
			),
		]),
		options: MEASUREMENT,
	}),
};

/**
 * 7 — save → recover → migrate → edit → export journey document (PRD §15.7).
 * Core-side the harness proves the DOCUMENT survives a JSON round trip and an
 * idempotent migrate with unknown keys intact; the full journey (TS-52) runs
 * editor-side where save/recovery live.
 */
const persistenceJourney: ContractFixture = {
	id: "persistence-journey",
	title: "Save/recover/migrate journey document",
	notes:
		"Layout-bearing, capability-complete, carrying unknown keys that must round-trip byte-identically (AC-001, NFR-COMPAT-001).",
	build: () => {
		const base = docOf(
			[
				frameWith(
					"journey-frame",
					[rect("journey-a", 40, 20), rect("journey-b", 40, 20)],
					{ gap: 10 },
				),
			],
			{
				compatibility: {
					schemaVersion: "3",
					minReaderSchemaVersion: "3",
					requiredCapabilities: ["layout.auto.v1"],
				},
			},
		);
		// Unknown top-level key — must survive every entry path (looseObject).
		return {
			ir: { ...base, vendorExtension: { theme: "spring" } } as CanvasIR,
			options: {},
		};
	},
};

/** 8 — scaled / skewed / rotated child (Review 0016, AC-012). */
const scaledSkewedRotated: ContractFixture = {
	id: "scaled-skewed-rotated",
	title: "Scaled, skewed, and rotated children",
	notes:
		"Fixed-axis scale passes through untouched (folding applies only to layout-controlled Fill/Hug axes); rotation and skew survive; flow spacing uses the transformed footprints (AC-012, §7.7).",
	build: () => ({
		ir: docOf([
			frameWith(
				"transforms",
				[
					rect("scaled", 40, 20, {
						transform: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 1.5 },
					}),
					rect("rotated", 40, 20, {
						transform: { x: 0, y: 0, rotation: 30, scaleX: 1, scaleY: 1 },
					}),
					rect("skewed", 40, 20, {
						transform: {
							x: 0,
							y: 0,
							rotation: 0,
							scaleX: 1,
							scaleY: 1,
							skewX: 15,
						},
					}),
				],
				{ gap: 12, padding: { top: 6, right: 6, bottom: 6, left: 6 } },
				{ bounds: { width: 320, height: 120 } },
			),
		]),
		options: {},
	}),
};

/** 9 — synthetic-unknown-capability document (Review 0016, AC-010). */
const unknownCapability: ContractFixture = {
	id: "unknown-capability",
	title: "Synthetic-unknown-capability document",
	notes:
		"Declares a capability this build does not implement: parses, resolves, serializes (stays exportable) and reports layout-capability-unsupported — never a schema rejection (AC-010).",
	build: () => ({
		ir: docOf(
			[
				frameWith(
					"future-frame",
					[rect("future-a", 40, 20), rect("future-b", 40, 20)],
					{ gap: 6 },
				),
			],
			{
				compatibility: {
					schemaVersion: "3",
					minReaderSchemaVersion: "3",
					requiredCapabilities: ["layout.auto.v1", "test.future.v9"],
				},
			},
		),
		options: {},
	}),
};

/** 10 — layout-bearing document missing its capability (Review 0016, AC-013). */
const missingCapability: ContractFixture = {
	id: "missing-capability",
	title: "Layout-bearing document missing its capability",
	notes:
		"Carries autoLayout but never declares layout.auto.v1: the missing-required-capability document invariant must reject the write (AC-013).",
	build: () => ({
		ir: docOf([
			frameWith(
				"undeclared-frame",
				[rect("undeclared-a", 40, 20), rect("undeclared-b", 40, 20)],
				{ gap: 6 },
			),
		]),
		options: {},
	}),
};

export const CONTRACT_FIXTURES: readonly ContractFixture[] = [
	ctaHugButton,
	logoCopyRow,
	nestedProductCard,
	pricingRowFill,
	absoluteBadge,
	localizedCopy,
	persistenceJourney,
	scaledSkewedRotated,
	unknownCapability,
	missingCapability,
];

/** The fixtures whose rect geometry the SVG parity harness compares 1:1. */
export const GEOMETRY_FIXTURE_IDS: readonly string[] = [
	"cta-hug-button",
	"logo-copy-row",
	"nested-product-card",
	"pricing-row-fill",
	"absolute-badge",
	"localized-copy-longer",
	"persistence-journey",
	"scaled-skewed-rotated",
	"unknown-capability",
];

export function contractFixture(id: string): ContractFixture {
	const fixture = CONTRACT_FIXTURES.find((f) => f.id === id);
	if (!fixture) throw new Error(`unknown contract fixture "${id}"`);
	return fixture;
}
