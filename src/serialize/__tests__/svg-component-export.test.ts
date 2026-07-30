import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import { resolveCanvasDocument } from "../../layout/resolve-document.js";
import type { MeasuredText, TextMeasureRequest } from "../../text-contracts.js";
import { serializePageToSvg } from "../svg.js";

/**
 * @file T-EXP-1 / T-EXP-2 (plan 0023 M6-01/M6-02, LC-EXPORT, INV-13, AC-012).
 *
 * The export path expands component instances through the SAME composed
 * resolver the editor reads, and never diverges SILENTLY: without a measurer it
 * still expands, but says so.
 */

const NOW = () => "2026-07-29T00:00:00.000Z";

/** 10px per character, flat 24 height — the layout suite's convention. */
const charMeasurer = (request: TextMeasureRequest): MeasuredText => {
	let chars = 0;
	for (const paragraph of request.paragraphs) {
		for (const span of paragraph.spans) chars += span.text.length;
	}
	return { lines: [], width: chars * 10, height: 24 };
};

/** A Source whose root HUGS its text, so measurement changes its geometry. */
function hugDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-hug",
		name: "Hug card",
		revision: 1,
		properties: [
			{
				id: "p-text",
				name: "Label",
				nodeId: "hug-text",
				kind: "text",
				targetKind: "text",
			},
		],
		root: {
			// A background so the frame emits a SIZED <rect> — otherwise a hug width
			// change is real in the resolution but invisible in the exported bytes,
			// and a byte assertion would pass for the wrong reason.
			...createFrame({
				id: "hug-root",
				bounds: { width: 50, height: 30 },
				background: "#abcdef",
			}),
			autoLayout: {
				version: 1,
				direction: "horizontal",
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				gap: 0,
				primaryAlign: "start",
				crossAlign: "start",
			},
			children: [
				{
					...createText({
						id: "hug-text",
						text: "ab",
						fontFamily: "Inter",
						fontSize: 12,
						fill: "#112233",
						bounds: { width: 20, height: 24 },
					}),
					// `{ widthSizing: "hug" }` is the real `CanvasLayoutItem` shape —
					// this is what makes the text's own measurement drive the geometry.
					layoutItem: { widthSizing: "hug" },
				} as CanvasNode,
			],
		} as CanvasNode,
	};
}

/** A plain (non-Hug) Source, for byte-level golden comparisons. */
function plainDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-plain",
		name: "Badge",
		revision: 2,
		properties: [],
		root: {
			...createFrame({
				id: "plain-root",
				bounds: { width: 60, height: 40 },
				background: "#eeeeee",
			}),
			children: [
				createRect({
					id: "plain-dot",
					transform: { x: 5, y: 5 },
					bounds: { width: 10, height: 10 },
					fill: "#ff0000",
				}),
			],
		} as CanvasNode,
	};
}

function docWith(
	definition: CanvasComponentDefinition,
	overrides?: CanvasComponentOverrideMap,
): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page], now: NOW });
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createComponentInstance({
			id: "inst-1",
			componentId: definition.id,
			transform: { x: 10, y: 20 },
			bounds: { width: 60, height: 40 },
			...(overrides ? { overrides } : {}),
			// The instance hugs too, so a measurement change inside the Source
			// propagates all the way out to the exported box (T-AL-1's shape).
			layoutItem: { widthSizing: "hug", heightSizing: "hug" },
		}),
		now: NOW,
	});
	return { ...ir, components: { [definition.id]: definition } };
}

describe("SVG component expansion (M6-02, T-EXP-2)", () => {
	it("paints the expanded Source content, not an empty instance", async () => {
		const { svg, warnings } = await serializePageToSvg(
			docWith(plainDefinition()),
			0,
		);
		// The Source's rect reaches the output even though the persistent instance
		// node has no children at all.
		expect(svg).toContain("#ff0000");
		expect(svg).toContain("#eeeeee");
		// M1-09's "nothing to paint" warning must NOT fire — the instance resolved.
		expect(
			warnings.some((w) => w.code === "COMPONENT_INSTANCE_UNRESOLVED"),
		).toBe(false);
	});

	it("places the expansion at the INSTANCE's transform, not the Source root's", async () => {
		const { svg } = await serializePageToSvg(docWith(plainDefinition()), 0);
		// The instance sits at (10,20); the Source root's own origin is (0,0).
		expect(svg).toContain("translate(10 20)");
	});

	it("applies an override to the exported content", async () => {
		const { svg } = await serializePageToSvg(
			docWith(hugDefinition(), {
				"p-text": {
					kind: "text",
					value: { kind: "plain", text: "OVERRIDDEN" },
				},
			}),
			0,
			{ textMeasurer: charMeasurer },
		);
		expect(svg).toContain("OVERRIDDEN");
		expect(svg).not.toContain(">ab<");
	});

	it("still reports an unresolvable instance instead of painting nothing silently", async () => {
		const broken: CanvasIR = { ...docWith(plainDefinition()), components: {} };
		const { warnings } = await serializePageToSvg(broken, 0);
		// Degradation keeps the M1-09 contract: the placeholder is a
		// `component-instance` at dispatch, so it warns and paints nothing.
		expect(
			warnings.some(
				(w) =>
					w.code === "COMPONENT_INSTANCE_UNRESOLVED" && w.nodeId === "inst-1",
			),
		).toBe(true);
	});

	it("leaves a component-free document byte-identical", async () => {
		const page = createPage({ id: "p1" });
		let ir = createCanvasIR({
			id: "plain",
			title: "t",
			pages: [page],
			now: NOW,
		});
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createRect({
				id: "r1",
				bounds: { width: 10, height: 10 },
				fill: "#00ff00",
			}),
			now: NOW,
		});
		const before = await serializePageToSvg(ir, 0);
		const after = await serializePageToSvg(ir, 0);
		expect(after.svg).toBe(before.svg);
		// The expansion path must not fire at all, so no component warning appears.
		expect(before.warnings.some((w) => w.code.startsWith("COMPONENT_"))).toBe(
			false,
		);
	});
});

describe("export measurement contract (M6-01, T-EXP-1, D-5, INV-13)", () => {
	it("warns COMPONENT_MEASUREMENT_MISSING naming component + instance", async () => {
		const { warnings } = await serializePageToSvg(docWith(hugDefinition()), 0);
		const warning = warnings.find(
			(w) => w.code === "COMPONENT_MEASUREMENT_MISSING",
		);
		expect(warning).toBeDefined();
		expect(warning?.nodeId).toBe("inst-1");
		expect(warning?.message).toContain("cmp-hug");
		expect(warning?.message).toContain("inst-1");
		// Actionable, not just a complaint.
		expect(warning?.fallback).toContain("textMeasurer");
	});

	it("does NOT warn when a measurer is supplied", async () => {
		const { warnings } = await serializePageToSvg(docWith(hugDefinition()), 0, {
			textMeasurer: charMeasurer,
		});
		expect(
			warnings.some((w) => w.code === "COMPONENT_MEASUREMENT_MISSING"),
		).toBe(false);
	});

	it("a measurer CHANGES Hug geometry — which is why its absence is warned", async () => {
		// The divergence needs content the STORED bounds no longer describe: a text
		// OVERRIDE ("ab" → 10 chars) that only a measurer can size. Without one the
		// export keeps the Source's stale 20px width — silently, before D-5.
		const doc = docWith(hugDefinition(), {
			"p-text": { kind: "text", value: { kind: "plain", text: "abcdefghij" } },
		});
		const measured = await serializePageToSvg(doc, 0, {
			textMeasurer: charMeasurer,
		});
		const unmeasured = await serializePageToSvg(doc, 0);

		// 10 chars × 10px measured, vs the stored 20px unmeasured.
		expect(measured.svg).toContain('width="100"');
		expect(unmeasured.svg).toContain('width="20"');
		expect(measured.svg).not.toBe(unmeasured.svg);
		// Exactly the divergence INV-13 conditions on a measurer, and that D-5
		// refuses to leave silent.
		expect(
			unmeasured.warnings.some(
				(w) => w.code === "COMPONENT_MEASUREMENT_MISSING",
			),
		).toBe(true);
	});

	it("does not warn about measurement for an instance that could not resolve", async () => {
		const broken: CanvasIR = { ...docWith(hugDefinition()), components: {} };
		const { warnings } = await serializePageToSvg(broken, 0);
		// Nothing expanded, so there is nothing to measure — one clear warning
		// about the missing Source beats two about a node that cannot render.
		expect(
			warnings.some((w) => w.code === "COMPONENT_MEASUREMENT_MISSING"),
		).toBe(false);
		expect(
			warnings.some((w) => w.code === "COMPONENT_INSTANCE_UNRESOLVED"),
		).toBe(true);
	});
});

describe("caller-supplied resolution is reused (AC-012)", () => {
	it("emits the CALLER's expanded tree instead of resolving a second time", async () => {
		const ir = docWith(hugDefinition());
		// The editor's own resolution, produced with its measurer.
		const shared = resolveCanvasDocument(ir, {
			measurement: { measureText: charMeasurer },
		});
		const withShared = await serializePageToSvg(ir, 0, {
			resolvedDocument: shared,
		});
		const withMeasurer = await serializePageToSvg(ir, 0, {
			textMeasurer: charMeasurer,
		});
		// Identical bytes: one resolver, one geometry — the AC-012 parity claim.
		expect(withShared.svg).toBe(withMeasurer.svg);
		// And no measurement warning, because the supplied resolution already
		// carries measured geometry — re-resolving would have thrown one.
		expect(
			withShared.warnings.some(
				(w) => w.code === "COMPONENT_MEASUREMENT_MISSING",
			),
		).toBe(false);
	});

	it("ignores a resolution that does not cover this page", async () => {
		const ir = docWith(plainDefinition());
		const other = resolveCanvasDocument(ir, { pageIds: ["does-not-exist"] });
		const { svg } = await serializePageToSvg(ir, 0, {
			resolvedDocument: other,
		});
		// Falls through to resolving this page, so content still appears.
		expect(svg).toContain("#ff0000");
	});

	it("does not warn LAYOUT_UNRESOLVED once it has expanded a layout-bearing page", async () => {
		const { warnings } = await serializePageToSvg(docWith(hugDefinition()), 0, {
			textMeasurer: charMeasurer,
		});
		// The expansion produced a resolution covering this page, so the stored-
		// geometry fallback warning would be actively misleading here.
		expect(warnings.some((w) => w.code === "LAYOUT_UNRESOLVED")).toBe(false);
	});
});
