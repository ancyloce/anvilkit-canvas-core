import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasIR,
	CanvasLayoutAlign,
	CanvasLayoutDirection,
	CanvasNode,
} from "../../ir/types.js";
import { MAX_TREE_DEPTH } from "../../limits.js";
import type { MeasuredText, TextMeasureRequest } from "../../text-contracts.js";
import { quantise, resolveCanvasLayout } from "../resolve.js";
import type { CanvasResolvedNodeRecord } from "../types.js";
import { createResolvedView } from "../types.js";

/**
 * @file T-M2-05 — the deterministic solver (TS-13, TS-17, TS-18, AC-002/004/005).
 */

const box = { width: 40, height: 20 };

function autoLayout(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		direction: "horizontal" as CanvasLayoutDirection,
		padding: { top: 0, right: 0, bottom: 0, left: 0 },
		gap: 0,
		primaryAlign: "start" as CanvasLayoutAlign,
		crossAlign: "start" as CanvasLayoutAlign,
		...overrides,
	};
}

function docOf(children: CanvasNode[]): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	for (const child of children) {
		ir = insertNode(ir, { parentId: page.root.id, node: child });
	}
	return ir;
}

function frameWith(
	id: string,
	children: CanvasNode[],
	layout: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
): CanvasNode {
	return {
		...createFrame({ id, bounds: { width: 200, height: 100 } }),
		autoLayout: autoLayout(layout),
		children,
		...overrides,
	} as CanvasNode;
}

function rect(id: string, overrides: Record<string, unknown> = {}): CanvasNode {
	return { ...createRect({ id, bounds: box }), ...overrides } as CanvasNode;
}

function resolve(ir: CanvasIR) {
	return resolveCanvasLayout(ir, {});
}

function geometryOf(
	document: ReturnType<typeof resolve>,
	id: string,
): CanvasResolvedNodeRecord["geometry"] {
	const record = createResolvedView(document).getRecord(id);
	if (!record) throw new Error(`no resolved record for "${id}"`);
	return record.geometry;
}

/** A measurer whose width is 10 per character and height a flat 24. */
const charMeasurer = (request: TextMeasureRequest): MeasuredText => {
	let chars = 0;
	for (const paragraph of request.paragraphs) {
		for (const span of paragraph.spans) chars += span.text.length;
	}
	return { lines: [], width: chars * 10, height: 24 };
};

describe("quantise (§6.1 precision policy)", () => {
	it("rounds half AWAY from zero, not toward +∞", () => {
		// The discriminating case. `Math.round(-0.5)` is `-0`, so a naive
		// implementation quantises -0.00005 to 0 while quantising +0.00005 to
		// 0.0001 — an asymmetry that shows up as a half-quantum drift between a
		// document and its mirror.
		expect(quantise(0.00005)).toBe(0.0001);
		expect(quantise(-0.00005)).toBe(-0.0001);
	});

	it("is symmetric about zero for every magnitude", () => {
		for (const value of [
			0, 0.00004, 0.00006, 0.001, 1.23456, 99.99995, 12345.6789,
		]) {
			expect(quantise(-value), String(value)).toBe(-quantise(value) || 0);
		}
	});

	it("rounds the double it was actually given", () => {
		// 0.00015 has no exact double; the nearest is fractionally BELOW the
		// half, so rounding it down is correct for the value that exists rather
		// than for the decimal literal that was typed. Asserting 0.0002 here
		// would be asserting against IEEE-754, not against this function.
		expect(0.00015 * 10_000).toBeLessThan(1.5);
		expect(quantise(0.00015)).toBe(0.0001);
	});

	it("produces the canonical double for a decimal", () => {
		// Division by 10,000 rather than multiplication by 1e-4 is what makes
		// this exact; the naive form yields 0.00030000000000000003.
		expect(quantise(0.0003)).toBe(0.0003);
		expect(String(quantise(0.0003))).toBe("0.0003");
	});

	it("normalises negative zero so output stays byte-stable", () => {
		expect(Object.is(quantise(-0.00001), 0)).toBe(true);
	});

	it("maps non-finite input to zero rather than propagating it", () => {
		expect(quantise(Number.NaN)).toBe(0);
		expect(quantise(Number.POSITIVE_INFINITY)).toBe(0);
	});
});

describe("flow placement (TS-13, AC-002)", () => {
	it("places children in children order with gap and four-sided padding", () => {
		const ir = docOf([
			frameWith("f1", [rect("a"), rect("b"), rect("c")], {
				gap: 12,
				padding: { top: 5, right: 7, bottom: 9, left: 11 },
			}),
		]);
		const resolved = resolve(ir);

		// x = padLeft + i * (childWidth + gap)
		expect(geometryOf(resolved, "a").localTransform.x).toBe(11);
		expect(geometryOf(resolved, "b").localTransform.x).toBe(11 + 40 + 12);
		expect(geometryOf(resolved, "c").localTransform.x).toBe(11 + 2 * (40 + 12));
		// Cross start alignment sits every child at padTop.
		for (const id of ["a", "b", "c"]) {
			expect(geometryOf(resolved, id).localTransform.y, id).toBe(5);
		}
	});

	it("keeps a hidden child in flow, consuming size and gap (§7.2)", () => {
		// Toggling an eye icon must not reflow the template, and the resolved
		// tree must not disagree with the layer tree about child order.
		const ir = docOf([
			frameWith("f1", [rect("a", { visible: false }), rect("b")], { gap: 10 }),
		]);
		const resolved = resolve(ir);

		expect(geometryOf(resolved, "a").localTransform.x).toBe(0);
		expect(geometryOf(resolved, "b").localTransform.x).toBe(50);
	});

	it("centers and end-aligns along the primary axis", () => {
		const build = (primaryAlign: CanvasLayoutAlign) =>
			docOf([frameWith("f1", [rect("a")], { primaryAlign })]);

		// frame 200 wide, child 40 → free 160
		expect(geometryOf(resolve(build("start")), "a").localTransform.x).toBe(0);
		expect(geometryOf(resolve(build("center")), "a").localTransform.x).toBe(80);
		expect(geometryOf(resolve(build("end")), "a").localTransform.x).toBe(160);
	});

	it("centers and end-aligns along the cross axis", () => {
		const build = (crossAlign: CanvasLayoutAlign) =>
			docOf([frameWith("f1", [rect("a")], { crossAlign })]);

		// frame 100 tall, child 20 → free 80
		expect(geometryOf(resolve(build("start")), "a").localTransform.y).toBe(0);
		expect(geometryOf(resolve(build("center")), "a").localTransform.y).toBe(40);
		expect(geometryOf(resolve(build("end")), "a").localTransform.y).toBe(80);
	});

	it("lays a vertical frame out as the transpose of its horizontal twin (TS-16)", () => {
		const horizontal = docOf([
			frameWith("f1", [rect("a"), rect("b")], {
				direction: "horizontal",
				gap: 8,
				padding: { top: 3, right: 4, bottom: 5, left: 6 },
			}),
		]);
		const vertical = docOf([
			frameWith(
				"f1",
				[
					rect("a", { bounds: { width: 20, height: 40 } }),
					rect("b", { bounds: { width: 20, height: 40 } }),
				],
				{
					direction: "vertical",
					gap: 8,
					// insets rotated a quarter turn: top↔left, right↔bottom
					padding: { top: 6, right: 5, bottom: 4, left: 3 },
				},
				{ bounds: { width: 100, height: 200 } },
			),
		]);
		const h = resolve(horizontal);
		const v = resolve(vertical);

		for (const id of ["a", "b"]) {
			expect(geometryOf(v, id).localTransform.y, id).toBe(
				geometryOf(h, id).localTransform.x,
			);
			expect(geometryOf(v, id).localTransform.x, id).toBe(
				geometryOf(h, id).localTransform.y,
			);
		}
	});
});

describe("Fill distribution (TS-18, AC-004)", () => {
	it("divides remaining space equally among Fill children", () => {
		const ir = docOf([
			frameWith(
				"f1",
				[
					rect("fixed"),
					rect("f1c", { layoutItem: { widthSizing: "fill" } }),
					rect("f2c", { layoutItem: { widthSizing: "fill" } }),
				],
				{ gap: 10 },
			),
		]);
		const resolved = resolve(ir);

		// inner 200; gapTotal 20; fixedTotal 40 → remaining 140 → 70 each
		expect(geometryOf(resolved, "f1c").bounds.width).toBe(70);
		expect(geometryOf(resolved, "f2c").bounds.width).toBe(70);
		expect(geometryOf(resolved, "f1c").localTransform.x).toBe(50);
		expect(geometryOf(resolved, "f2c").localTransform.x).toBe(130);
	});

	it("clamps fillSize to zero rather than producing a negative bound", () => {
		const ir = docOf([
			frameWith(
				"f1",
				[
					rect("wide", { bounds: { width: 400, height: 20 } }),
					rect("filler", { layoutItem: { widthSizing: "fill" } }),
				],
				{},
			),
		]);
		const resolved = resolve(ir);

		expect(geometryOf(resolved, "filler").bounds.width).toBe(0);
	});

	it("gives a cross-axis Fill child the parent's inner cross size", () => {
		const ir = docOf([
			frameWith("f1", [rect("a", { layoutItem: { heightSizing: "fill" } })], {
				padding: { top: 10, right: 0, bottom: 10, left: 0 },
			}),
		]);
		const resolved = resolve(ir);

		// frame 100 tall minus 20 padding → 80
		expect(geometryOf(resolved, "a").bounds.height).toBe(80);
	});

	it("never collapses gap when space runs out (§7.3)", () => {
		// Gap never collapses: an overfull frame overflows instead, because
		// collapsing would break the one spacing guarantee the container gives.
		const ir = docOf([
			frameWith(
				"f1",
				[
					rect("a", { bounds: { width: 150, height: 20 } }),
					rect("b", { bounds: { width: 150, height: 20 } }),
				],
				{ gap: 30 },
			),
		]);
		const resolved = resolve(ir);

		expect(geometryOf(resolved, "b").localTransform.x).toBe(180);
		expect(resolved.diagnostics.map((d) => d.code)).toContain(
			"layout-insufficient-space",
		);
	});

	it("reports insufficient space once per container and axis, not per child", () => {
		// Diagnostic COUNT is part of the determinism contract, so a
		// container-level condition must not scale with child count.
		const ir = docOf([
			frameWith(
				"f1",
				[
					rect("a", { bounds: { width: 300, height: 20 } }),
					rect("b", { bounds: { width: 300, height: 20 } }),
					rect("c", { bounds: { width: 300, height: 20 } }),
				],
				{},
			),
		]);
		const resolved = resolve(ir);
		const overflow = resolved.diagnostics.filter(
			(d) => d.code === "layout-insufficient-space",
		);

		expect(overflow).toHaveLength(1);
		expect(overflow[0]?.nodeId).toBe("f1");
		expect(overflow[0]?.message).toContain("a, b, c");
	});
});

describe("Hug sizing (AC-003, TS-17)", () => {
	it("sizes a Hug frame from children plus padding plus gap", () => {
		const ir = docOf([
			frameWith(
				"f1",
				[rect("a"), rect("b")],
				{ gap: 10, padding: { top: 4, right: 6, bottom: 8, left: 2 } },
				{ layoutItem: { widthSizing: "hug", heightSizing: "hug" } },
			),
		]);
		const resolved = resolve(ir);

		// width  = 2 + 40 + 10 + 40 + 6  = 98
		// height = 4 + 20 + 8            = 32
		expect(geometryOf(resolved, "f1").bounds).toEqual({
			width: 98,
			height: 32,
		});
	});

	it("recomputes Hug ancestors when inner content changes (TS-17)", () => {
		const build = (text: string) =>
			docOf([
				frameWith(
					"outer",
					[
						frameWith(
							"inner",
							[
								{
									...createText({ id: "t", text, bounds: box }),
									layoutItem: { widthSizing: "hug" },
								} as CanvasNode,
							],
							{},
							{ layoutItem: { widthSizing: "hug" } },
						),
					],
					{},
					{ layoutItem: { widthSizing: "hug" } },
				),
			]);

		const short = resolveCanvasLayout(build("ab"), {
			measurement: { measureText: charMeasurer },
		});
		const long = resolveCanvasLayout(build("abcdef"), {
			measurement: { measureText: charMeasurer },
		});

		expect(geometryOf(short, "t").bounds.width).toBe(20);
		expect(geometryOf(short, "inner").bounds.width).toBe(20);
		expect(geometryOf(short, "outer").bounds.width).toBe(20);
		expect(geometryOf(long, "t").bounds.width).toBe(60);
		expect(geometryOf(long, "inner").bounds.width).toBe(60);
		expect(geometryOf(long, "outer").bounds.width).toBe(60);
	});

	it("falls back to stored bounds when no measurer is supplied", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createText({ id: "t", text: "hello", bounds: box }),
					layoutItem: { widthSizing: "hug" },
				} as CanvasNode,
			]),
		]);
		const resolved = resolve(ir);

		expect(geometryOf(resolved, "t").bounds.width).toBe(box.width);
		expect(resolved.diagnostics.map((d) => d.code)).toContain(
			"layout-measurement-missing",
		);
	});
});

describe("Absolute children (§7.6)", () => {
	const ir = () =>
		docOf([
			frameWith(
				"f1",
				[
					rect("flow"),
					rect("badge", {
						layoutItem: { positioning: "absolute" },
						transform: { x: 7, y: 9, rotation: 0, scaleX: 1, scaleY: 1 },
					}),
				],
				{ gap: 10, padding: { top: 20, right: 20, bottom: 20, left: 20 } },
				{ layoutItem: { widthSizing: "hug" } },
			),
		]);

	it("positions from the frame's border-box origin, not the padding box", () => {
		// Keeping absolute positioning independent of padding is what lets an
		// author change padding without every badge moving.
		const resolved = resolve(ir());
		expect(geometryOf(resolved, "badge").localTransform.x).toBe(7);
		expect(geometryOf(resolved, "badge").localTransform.y).toBe(9);
	});

	it("is excluded from flow count, gap and Hug", () => {
		const resolved = resolve(ir());
		// Hug width counts ONLY the flow child: 20 + 40 + 20 = 80. If the badge
		// counted, a gap would appear too.
		expect(geometryOf(resolved, "f1").bounds.width).toBe(80);
		expect(geometryOf(resolved, "flow").localTransform.x).toBe(20);
	});

	it("keeps a Hug container smaller than an overhanging Absolute child", () => {
		// Explicitly correct per §7.6, and emits no diagnostic — but the editor
		// must keep such a node reachable through the layer tree.
		const resolved = resolve(
			docOf([
				frameWith(
					"f1",
					[
						rect("flow"),
						rect("big", {
							layoutItem: { positioning: "absolute" },
							bounds: { width: 500, height: 500 },
						}),
					],
					{},
					{ layoutItem: { widthSizing: "hug", heightSizing: "hug" } },
				),
			]),
		);

		expect(geometryOf(resolved, "f1").bounds.width).toBe(40);
		expect(geometryOf(resolved, "big").bounds.width).toBe(500);
	});
});

describe("scale normalisation and footprints (§7.7, AC-012)", () => {
	it("normalises scale to 1 on a Fill axis and folds it into bounds", () => {
		// The motivating case: without normalisation a scaleX:2 Fill child handed
		// fillSize would occupy fillSize × 2 and overflow its container.
		const ir = docOf([
			frameWith("f1", [
				rect("a", {
					layoutItem: { widthSizing: "fill" },
					transform: { x: 0, y: 0, rotation: 0, scaleX: 2, scaleY: 1 },
				}),
			]),
		]);
		const geometry = geometryOf(resolve(ir), "a");

		expect(geometry.localTransform.scaleX).toBe(1);
		expect(geometry.bounds.width).toBe(200);
		expect(geometry.layoutFootprint.maxX - geometry.layoutFootprint.minX).toBe(
			200,
		);
	});

	it("leaves scale untouched on a Fixed axis", () => {
		// Layout does not own a Fixed axis's size, so it must not rewrite it.
		const ir = docOf([
			frameWith("f1", [
				rect("a", {
					transform: { x: 0, y: 0, rotation: 0, scaleX: 3, scaleY: 1 },
				}),
			]),
		]);
		const geometry = geometryOf(resolve(ir), "a");

		expect(geometry.localTransform.scaleX).toBe(3);
		expect(geometry.bounds.width).toBe(40);
	});

	it("allocates a rotated child its axis-aligned footprint, preserving rotation", () => {
		const ir = docOf([
			frameWith("f1", [
				rect("r", {
					bounds: { width: 100, height: 100 },
					transform: { x: 0, y: 0, rotation: 45, scaleX: 1, scaleY: 1 },
				}),
				rect("after"),
			]),
		]);
		const resolved = resolve(ir);
		const rotated = geometryOf(resolved, "r");
		const expected = Math.SQRT2 * 100;

		expect(rotated.localTransform.rotation).toBe(45);
		expect(
			rotated.layoutFootprint.maxX - rotated.layoutFootprint.minX,
		).toBeCloseTo(expected, 3);
		// The next sibling starts after the full footprint, not after `width`.
		expect(geometryOf(resolved, "after").localTransform.x).toBeCloseTo(
			expected,
			3,
		);
	});

	it("satisfies the footprint invariant for a rotated single-axis Fill child", () => {
		// TS-08's core claim: on a layout-controlled axis, the resolved footprint
		// extent equals the size the solver allocated. With rotation this needs
		// the 2×2 solve — a naive `bounds.width = fillSize` would leave the
		// footprint at width·cos30 + height·sin30, well over the allocation.
		const ir = docOf([
			frameWith("f1", [
				rect("a", {
					bounds: { width: 100, height: 100 },
					layoutItem: { widthSizing: "fill" },
					transform: { x: 0, y: 0, rotation: 30, scaleX: 1, scaleY: 1 },
				}),
			]),
		]);
		const geometry = geometryOf(resolve(ir), "a");

		expect(
			geometry.layoutFootprint.maxX - geometry.layoutFootprint.minX,
		).toBeCloseTo(200, 3);
		expect(geometry.localTransform.rotation).toBe(30);
	});

	it("satisfies the invariant on BOTH axes when the target is reachable", () => {
		const ir = docOf([
			frameWith(
				"f1",
				[
					rect("a", {
						bounds: { width: 100, height: 100 },
						layoutItem: { widthSizing: "fill", heightSizing: "fill" },
						transform: { x: 0, y: 0, rotation: 30, scaleX: 1, scaleY: 1 },
					}),
				],
				{},
				{ bounds: { width: 300, height: 300 } },
			),
		]);
		const geometry = geometryOf(resolve(ir), "a");

		expect(
			geometry.layoutFootprint.maxX - geometry.layoutFootprint.minX,
		).toBeCloseTo(300, 3);
		expect(
			geometry.layoutFootprint.maxY - geometry.layoutFootprint.minY,
		).toBeCloseTo(300, 3);
	});

	it("degrades gracefully when a rotation makes the allocation unreachable", () => {
		// A 200×100 frame asking a 30°-rotated child to Fill both axes is
		// over-constrained: no non-negative box rotated 30° has that extent
		// ratio (the solve returns a negative height). The solver clamps to a
		// non-negative box and lets the content overflow, which is the same
		// posture it takes everywhere else — it must never emit a negative
		// bound, and it must not iterate looking for a solution that does not
		// exist. No diagnostic: TD §14's code union is frozen at 11 members and
		// has none for this, and inventing a twelfth would create the parallel
		// taxonomy the design forbids.
		const ir = docOf([
			frameWith("f1", [
				rect("a", {
					bounds: { width: 100, height: 100 },
					layoutItem: { widthSizing: "fill", heightSizing: "fill" },
					transform: { x: 0, y: 0, rotation: 30, scaleX: 1, scaleY: 1 },
				}),
			]),
		]);
		const geometry = geometryOf(resolve(ir), "a");

		expect(geometry.bounds.width).toBeGreaterThanOrEqual(0);
		expect(geometry.bounds.height).toBe(0);
		expect(Number.isFinite(geometry.bounds.width)).toBe(true);
	});

	it("preserves skew and still produces a well-defined footprint", () => {
		const ir = docOf([
			frameWith("f1", [
				rect("a", {
					layoutItem: { widthSizing: "fill" },
					transform: {
						x: 0,
						y: 0,
						rotation: 0,
						scaleX: 1,
						scaleY: 1,
						skewX: 0.5,
					},
				}),
			]),
		]);
		const geometry = geometryOf(resolve(ir), "a");

		expect(geometry.localTransform.skewX).toBe(0.5);
		expect(
			geometry.layoutFootprint.maxX - geometry.layoutFootprint.minX,
		).toBeCloseTo(200, 3);
	});
});

describe("world transforms and records", () => {
	it("composes world transforms through nested containers", () => {
		const ir = docOf([
			frameWith(
				"outer",
				[frameWith("inner", [rect("leaf")], {}, {})],
				{ padding: { top: 10, right: 0, bottom: 0, left: 10 } },
				{
					transform: { x: 100, y: 50, rotation: 0, scaleX: 1, scaleY: 1 },
				},
			),
		]);
		const geometry = geometryOf(resolve(ir), "leaf");

		// outer at (100,50) + padding (10,10) → inner at (110,60); leaf at 0,0.
		expect(geometry.worldTransform[4]).toBe(110);
		expect(geometry.worldTransform[5]).toBe(60);
		expect(geometry.worldAabb.minX).toBe(110);
		expect(geometry.worldAabb.maxX).toBe(150);
	});

	it("stores children in flow order and exposes page roots", () => {
		const ir = docOf([frameWith("f1", [rect("a"), rect("b")])]);
		const resolved = resolve(ir);
		const view = createResolvedView(resolved);

		expect(view.getChildren("f1").map((r) => r.sourceNodeId)).toEqual([
			"a",
			"b",
		]);
		expect(view.getPageRoots("p1")).toHaveLength(1);
	});

	it("emits absolute children in source order, not sizing order", () => {
		// Flow and absolute children are sized in two groups; the resolved tree
		// must still agree with the layer tree about order.
		const ir = docOf([
			frameWith("f1", [
				rect("a"),
				rect("abs", { layoutItem: { positioning: "absolute" } }),
				rect("b"),
			]),
		]);
		const view = createResolvedView(resolve(ir));

		expect(view.getChildren("f1").map((r) => r.sourceNodeId)).toEqual([
			"a",
			"abs",
			"b",
		]);
	});

	it("resolves only the requested pages", () => {
		const p1 = createPage({ id: "p1" });
		const p2 = createPage({ id: "p2" });
		const ir = createCanvasIR({ id: "d", title: "t", pages: [p1, p2] });
		const resolved = resolveCanvasLayout(ir, { pageIds: ["p2"] });

		expect([...resolved.pageRoots.keys()]).toEqual(["p2"]);
	});

	it("leaves a document with no layout intent geometrically unchanged", () => {
		const ir = docOf([
			rect("a", {
				transform: { x: 13, y: 17, rotation: 20, scaleX: 2, scaleY: 3 },
			}),
		]);
		const geometry = geometryOf(resolve(ir), "a");

		expect(geometry.localTransform).toEqual({
			x: 13,
			y: 17,
			rotation: 20,
			scaleX: 2,
			scaleY: 3,
		});
		expect(geometry.bounds).toEqual(box);
	});
});

describe("determinism and bounds (AC-008, NFR-REL-001)", () => {
	it("produces identical geometry and diagnostics across repeated runs", () => {
		const ir = docOf([
			frameWith(
				"f1",
				[
					rect("a", { layoutItem: { widthSizing: "fill" } }),
					rect("b", { layoutItem: { widthSizing: "fill" } }),
					rect("c", { layoutItem: { widthSizing: "fill" } }),
				],
				{ gap: 7, primaryAlign: "center", crossAlign: "center" },
			),
		]);

		const first = resolve(ir);
		for (let i = 0; i < 5; i++) {
			const again = resolve(ir);
			for (const [id, record] of first.records) {
				expect(again.records.get(id)?.geometry, id).toEqual(record.geometry);
			}
			expect(again.diagnostics).toEqual(first.diagnostics);
			expect(again.inputHash).toBe(first.inputHash);
		}
	});

	it("never produces a NaN, Infinity or negative bound", () => {
		const ir = docOf([
			frameWith(
				"f1",
				[
					rect("a", { layoutItem: { widthSizing: "fill" } }),
					rect("b", { bounds: { width: 9999, height: 9999 } }),
				],
				{ gap: 50, padding: { top: 90, right: 90, bottom: 90, left: 90 } },
			),
		]);
		const resolved = resolve(ir);

		for (const record of resolved.records.values()) {
			const { bounds, localTransform } = record.geometry;
			for (const value of [
				bounds.width,
				bounds.height,
				localTransform.x,
				localTransform.y,
			]) {
				expect(Number.isFinite(value), record.sourceNodeId).toBe(true);
			}
			expect(bounds.width).toBeGreaterThanOrEqual(0);
			expect(bounds.height).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("convergence and depth (§7.8, §14)", () => {
	it("does not throw on a tree past MAX_TREE_DEPTH, and reports it", () => {
		// The walkers throw `CanvasIRDepthError` → `excessive-tree-depth` as the
		// document-level fact; the resolver stops descending and reports the
		// resolution-level consequence. A document may legitimately produce both.
		// Built by hand, NOT with `insertNode`: the mutation API refuses to
		// create a tree this deep (it throws `CanvasIRDepthError`). A document
		// this shape reaches the resolver from a corrupt or hostile file, which
		// is exactly the case the resolver must survive without throwing.
		const page = createPage({ id: "p1" });
		let spine: CanvasNode = createFrame({
			id: `f${MAX_TREE_DEPTH + 5}`,
			bounds: box,
		});
		for (let i = MAX_TREE_DEPTH + 4; i >= 0; i--) {
			spine = {
				...createFrame({ id: `f${i}`, bounds: box }),
				children: [spine],
			} as CanvasNode;
		}
		const ir = createCanvasIR({
			id: "d",
			title: "t",
			pages: [{ ...page, root: { ...page.root, children: [spine] } }],
		});

		const resolved = resolve(ir);

		expect(resolved.diagnostics.map((d) => d.code)).toContain(
			"layout-depth-exceeded",
		);
		expect(resolved.records.size).toBeGreaterThan(0);
	});

	it("keeps nested Fill containers linear rather than exponential", () => {
		// Without the enforced two-sizing cap, each nested Fill level re-resolves
		// its whole subtree and work grows as 2^depth — at the permitted depth of
		// 10 that is a thousandfold blow-up on an ordinary-looking document.
		let inner: CanvasNode = rect("leaf", {
			layoutItem: { widthSizing: "fill" },
		});
		for (let i = 0; i < 12; i++) {
			inner = frameWith(
				`f${i}`,
				[inner],
				{},
				{ layoutItem: { widthSizing: "fill" } },
			);
		}
		const started = Date.now();
		const resolved = resolve(docOf([inner]));

		expect(resolved.records.size).toBeGreaterThan(0);
		expect(Date.now() - started).toBeLessThan(1_000);
	});
});
