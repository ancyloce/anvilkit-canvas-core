import { describe, expect, it } from "vitest";
import { validateCanvasIRInvariants } from "../../../ir/invariants.js";
import type { CanvasIR } from "../../../ir/types.js";
import { migrateCanvasIR } from "../../../ir/validators.js";
import { serializePageToSvg } from "../../../serialize/index.js";
import { resolveCanvasLayout } from "../../resolve.js";
import type {
	CanvasResolvedDocument,
	CanvasResolvedNodeRecord,
} from "../../types.js";
import { createResolvedView } from "../../types.js";
import { validateLayoutInvariants } from "../../validate.js";
import {
	CONTRACT_FIXTURES,
	contractFixture,
	contractMeasureText,
	GEOMETRY_FIXTURE_IDS,
} from "./fixtures.js";

/**
 * @file T-M5-01 (TS-43, TS-57 core half) — resolver ↔ SVG contract parity
 * over the full fixture corpus. The editor-side consumers (renderer,
 * raster/PDF export) assert against mirrored documents in
 * `@anvilkit/canvas-editor`; a fixture that passes only in the resolver is
 * not covered.
 *
 * ## AC-009 tolerance — PROVISIONAL under OQ-4 (recorded here per T-M5-01)
 *
 * The resolver quantises every written coordinate to the 1e-4 grid
 * (`quantise`, round-half-away-from-zero) and the SVG serializer formats all
 * numbers through `fmt` (4-dp rounding). Both sides therefore live on the
 * SAME grid and numeric agreement is asserted at ≤ 1e-3 local units — one
 * order of magnitude above the grid, zero orders above visual perception.
 * Pixel-level screenshot comparison (CI browser baselines, T-M5-02) is
 * proposed at ≤ 0.5 device px. OQ-4 sign-off may tighten the numeric bound
 * to exact-string equality; it must not loosen it without a recorded
 * decision.
 */
const TOLERANCE = 1e-3;

function near(actual: number, expected: number, label: string): void {
	expect(
		Math.abs(actual - expected),
		`${label}: ${actual} vs ${expected}`,
	).toBeLessThanOrEqual(TOLERANCE);
}

interface SvgRect {
	width: number;
	height: number;
	x: number;
	y: number;
	rotation: number;
	isMatrix: boolean;
}

/** Every `<rect` element in document order, with its decomposed placement. */
function extractSvgRects(svg: string): SvgRect[] {
	const out: SvgRect[] = [];
	for (const match of svg.matchAll(/<rect\b([^>]*)\/>/g)) {
		const attrs = match[1] ?? "";
		const num = (name: string): number => {
			const m = attrs.match(new RegExp(`${name}="([-\\d.]+)"`));
			return m?.[1] ? Number(m[1]) : 0;
		};
		const transform = attrs.match(/transform="([^"]*)"/)?.[1] ?? "";
		const translate = transform.match(
			/translate\(([-\d.]+)(?:[ ,]([-\d.]+))?\)/,
		);
		const rotate = transform.match(/rotate\(([-\d.]+)\)/);
		out.push({
			width: num("width"),
			height: num("height"),
			x: translate?.[1] ? Number(translate[1]) : 0,
			y: translate?.[2] ? Number(translate[2]) : 0,
			rotation: rotate?.[1] ? Number(rotate[1]) : 0,
			isMatrix: transform.startsWith("matrix("),
		});
	}
	return out;
}

/** Rect-kind resolved records in flow (= emission) order for one page. */
function rectRecordsInOrder(
	resolved: CanvasResolvedDocument,
	pageId: string,
): CanvasResolvedNodeRecord[] {
	const view = createResolvedView(resolved);
	const out: CanvasResolvedNodeRecord[] = [];
	const visit = (record: CanvasResolvedNodeRecord): void => {
		if (record.node.type === "rect") out.push(record);
		for (const child of view.getChildren(record.id)) visit(child);
	};
	for (const rootId of resolved.pageRoots.get(pageId) ?? []) {
		const record = view.getRecord(rootId);
		if (record) visit(record);
	}
	return out;
}

async function serialize(
	ir: CanvasIR,
	resolved: CanvasResolvedDocument,
): Promise<{ svg: string; codes: string[] }> {
	const { svg, warnings } = await serializePageToSvg(ir, "p1", {
		resolvedDocument: resolved,
		textMeasurer: contractMeasureText,
	});
	return { svg, codes: warnings.map((w) => w.code) };
}

describe("contract corpus sanity", () => {
	it("carries all ten fixtures of the TD corpus", () => {
		expect(CONTRACT_FIXTURES.map((f) => f.id)).toEqual([
			"cta-hug-button",
			"logo-copy-row",
			"nested-product-card",
			"pricing-row-fill",
			"absolute-badge",
			"localized-copy-longer",
			"persistence-journey",
			"scaled-skewed-rotated",
			"unknown-capability",
			"missing-capability",
		]);
	});
});

describe("resolver ↔ SVG geometry parity (TS-43, AC-009)", () => {
	for (const id of GEOMETRY_FIXTURE_IDS) {
		it(`agrees on every rect for "${id}" within the documented tolerance`, async () => {
			const { ir, options } = contractFixture(id).build();
			const resolved = resolveCanvasLayout(ir, options);
			const { svg, codes } = await serialize(ir, resolved);
			expect(codes).not.toContain("LAYOUT_UNRESOLVED");

			// The serializer emits the PAGE background as the first <rect;
			// content rects follow in flow order.
			const allRects = extractSvgRects(svg);
			const svgRects = allRects.slice(1);
			const records = rectRecordsInOrder(resolved, "p1");
			expect(svgRects.length, "rect count").toBe(records.length);
			expect(records.length).toBeGreaterThan(0);

			for (const [i, record] of records.entries()) {
				const el = svgRects[i];
				if (!el) throw new Error(`missing SVG rect ${i}`);
				const label = `${id}/${record.sourceNodeId}`;
				if (el.isMatrix) {
					// Skew serializes as matrix(a b c d e f); the numeric
					// components are covered by the resolver property suite —
					// parity here asserts size, which stays attribute-level.
					near(el.width, record.geometry.bounds.width, `${label} width`);
					near(el.height, record.geometry.bounds.height, `${label} height`);
					continue;
				}
				near(el.x, record.geometry.localTransform.x, `${label} x`);
				near(el.y, record.geometry.localTransform.y, `${label} y`);
				near(el.width, record.geometry.bounds.width, `${label} width`);
				near(el.height, record.geometry.bounds.height, `${label} height`);
				near(
					el.rotation,
					record.geometry.localTransform.rotation ?? 0,
					`${label} rotation`,
				);
			}
		});
	}

	it("Fixed-axis scale passes through to SVG untouched while flow spacing uses the scaled footprint (§7.7)", async () => {
		// Layout does not own a Fixed axis's size, so the resolver leaves
		// scale in the transform (folding into bounds happens only on
		// layout-controlled Fill/Hug axes — pinned by the resolver suite).
		const { ir, options } = contractFixture("scaled-skewed-rotated").build();
		const resolved = resolveCanvasLayout(ir, options);
		const { svg } = await serialize(ir, resolved);
		expect(svg).toContain('transform="translate(6 6) scale(2 1.5)"');
		// The rotated sibling starts after the SCALED footprint, not after the
		// raw 40-unit width — both sides agree because the SVG places it with
		// the resolver's own local transform.
		const view = createResolvedView(resolved);
		const rotated = view.getRecord("rotated");
		expect(rotated).toBeDefined();
		expect(svg).toContain(
			`translate(${rotated?.geometry.localTransform.x} ${rotated?.geometry.localTransform.y}) rotate(30)`,
		);
	});
});

describe("determinism across consumers (TS-57 discipline)", () => {
	for (const id of GEOMETRY_FIXTURE_IDS) {
		it(`resolves and serializes "${id}" byte-identically across runs`, async () => {
			const { ir, options } = contractFixture(id).build();
			const first = resolveCanvasLayout(ir, options);
			const second = resolveCanvasLayout(ir, options);
			expect(second.diagnostics).toEqual(first.diagnostics);
			expect(second.inputHash).toBe(first.inputHash);
			const a = await serialize(ir, first);
			const b = await serialize(ir, second);
			expect(b.svg).toBe(a.svg);
		});
	}
});

describe("persistence-journey document (fixture 7, core half)", () => {
	it("survives a JSON round trip and an idempotent migrate with unknown keys intact", () => {
		const { ir } = contractFixture("persistence-journey").build();
		const parsed = JSON.parse(JSON.stringify(ir)) as Record<string, unknown>;
		const migrated = migrateCanvasIR(parsed);
		expect(
			(migrated as unknown as Record<string, unknown>).vendorExtension,
		).toEqual({ theme: "spring" });
		expect(migrated.compatibility?.requiredCapabilities).toEqual([
			"layout.auto.v1",
		]);
		const again = migrateCanvasIR(
			JSON.parse(JSON.stringify(migrated)) as Record<string, unknown>,
		);
		expect(again).toEqual(migrated);
	});
});

describe("capability fixtures (AC-010, AC-013)", () => {
	it("unknown capability degrades: parses, resolves, serializes, and reports layout-capability-unsupported", async () => {
		const { ir, options } = contractFixture("unknown-capability").build();
		const migrated = migrateCanvasIR(
			JSON.parse(JSON.stringify(ir)) as Record<string, unknown>,
		);
		const issues = validateLayoutInvariants(migrated);
		expect(
			issues.some((issue) => issue.code === "layout-capability-unsupported"),
		).toBe(true);
		const resolved = resolveCanvasLayout(migrated, options);
		const { codes } = await serialize(migrated, resolved);
		expect(codes).not.toContain("LAYOUT_UNRESOLVED");
	});

	it("a layout-bearing document missing its capability is rejected by the document invariant", () => {
		const { ir } = contractFixture("missing-capability").build();
		const issues = validateCanvasIRInvariants(ir);
		expect(
			issues.some((issue) => issue.code === "missing-required-capability"),
		).toBe(true);
	});

	it("the capability-complete journey document passes the same invariant", () => {
		const { ir } = contractFixture("persistence-journey").build();
		const issues = validateCanvasIRInvariants(ir);
		expect(
			issues.some((issue) => issue.code === "missing-required-capability"),
		).toBe(false);
	});
});
