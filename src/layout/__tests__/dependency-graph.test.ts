import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import { buildSizingGraph, emptySizingGraph } from "../dependency-graph.js";

/**
 * @file T-M2-04 — sizing dependency graph (TS-12).
 */

const box = { width: 40, height: 40 };

const layout = {
	version: 1,
	direction: "horizontal",
	padding: { top: 0, right: 0, bottom: 0, left: 0 },
	gap: 0,
	primaryAlign: "start",
	crossAlign: "start",
} as const;

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
	overrides?: Record<string, unknown>,
): CanvasNode {
	return {
		...createFrame({ id, bounds: box }),
		autoLayout: layout,
		children,
		...overrides,
	} as CanvasNode;
}

function findNode(ir: CanvasIR, id: string): CanvasNode {
	const search = (node: CanvasNode): CanvasNode | undefined => {
		if (node.id === id) return node;
		for (const child of (node as { children?: CanvasNode[] }).children ?? []) {
			const hit = search(child);
			if (hit) return hit;
		}
		return undefined;
	};
	const found = search(ir.pages[0]?.root as CanvasNode);
	if (!found) throw new Error(`fixture is missing node "${id}"`);
	return found;
}

describe("buildSizingGraph (T-M2-04)", () => {
	it("passes eligible intent through untouched", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createRect({ id: "r1", bounds: box }),
					layoutItem: { widthSizing: "fill", heightSizing: "fixed" },
				} as CanvasNode,
			]),
		]);
		const graph = buildSizingGraph(ir);
		const rect = findNode(ir, "r1");

		expect(graph.effectiveSizing(rect, "widthSizing")).toBe("fill");
		expect(graph.effectiveSizing(rect, "heightSizing")).toBe("fixed");
		expect(graph.wasDemoted(rect, "widthSizing")).toBe(false);
	});

	it("defaults an absent layoutItem to fixed on both axes", () => {
		const ir = docOf([
			frameWith("f1", [createRect({ id: "r1", bounds: box })]),
		]);
		const graph = buildSizingGraph(ir);
		const rect = findNode(ir, "r1");

		expect(graph.effectiveSizing(rect, "widthSizing")).toBe("fixed");
		expect(graph.effectiveSizing(rect, "heightSizing")).toBe("fixed");
	});

	// TS-12. The acceptance criterion is specifically that this is decided
	// BEFORE main-axis arithmetic — the graph is built from the IR alone, so a
	// cycle can never reach the solver's sizing loop at all.
	it("demotes a Fill child of a Hug parent on the same axis to fixed", () => {
		const ir = docOf([
			frameWith(
				"f1",
				[
					{
						...createRect({ id: "r1", bounds: box }),
						layoutItem: { widthSizing: "fill" },
					} as CanvasNode,
				],
				{ layoutItem: { widthSizing: "hug" } },
			),
		]);
		const graph = buildSizingGraph(ir);
		const rect = findNode(ir, "r1");

		expect(graph.issues.map((i) => i.code)).toContain("layout-circular-sizing");
		expect(graph.effectiveSizing(rect, "widthSizing")).toBe("fixed");
		expect(graph.wasDemoted(rect, "widthSizing")).toBe(true);
	});

	it("demotes only the cycling axis, leaving the other alone", () => {
		const ir = docOf([
			frameWith(
				"f1",
				[
					{
						...createRect({ id: "r1", bounds: box }),
						layoutItem: { widthSizing: "fill", heightSizing: "fill" },
					} as CanvasNode,
				],
				{ layoutItem: { widthSizing: "hug" } },
			),
		]);
		const graph = buildSizingGraph(ir);
		const rect = findNode(ir, "r1");

		expect(graph.effectiveSizing(rect, "widthSizing")).toBe("fixed");
		expect(graph.effectiveSizing(rect, "heightSizing")).toBe("fill");
	});

	it("demotes Fill with no Auto Layout parent", () => {
		const ir = docOf([
			{
				...createRect({ id: "r1", bounds: box }),
				layoutItem: { widthSizing: "fill" },
			} as CanvasNode,
		]);
		const graph = buildSizingGraph(ir);

		expect(graph.issues.map((i) => i.code)).toContain(
			"layout-fill-without-parent",
		);
		expect(graph.effectiveSizing(findNode(ir, "r1"), "widthSizing")).toBe(
			"fixed",
		);
	});

	it("demotes Hug on a kind with no intrinsic size", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createRect({ id: "r1", bounds: box }),
					layoutItem: { heightSizing: "hug" },
				} as CanvasNode,
			]),
		]);
		const graph = buildSizingGraph(ir);

		expect(graph.effectiveSizing(findNode(ir, "r1"), "heightSizing")).toBe(
			"fixed",
		);
	});

	it("demotes Fill on a `text` node's inline axis but not its block axis", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createText({ id: "t1", text: "hi", bounds: box }),
					layoutItem: { widthSizing: "fill", heightSizing: "fill" },
				} as CanvasNode,
			]),
		]);
		const graph = buildSizingGraph(ir);
		const text = findNode(ir, "t1");

		expect(graph.effectiveSizing(text, "widthSizing")).toBe("fixed");
		// A `text` node has a real block extent (its line height), so Fill there
		// is legitimate — demoting both axes would be over-correction.
		expect(graph.effectiveSizing(text, "heightSizing")).toBe("fill");
	});

	it("demotes an absolutely-positioned child's Fill", () => {
		const ir = docOf([
			frameWith("f1", [
				{
					...createRect({ id: "r1", bounds: box }),
					layoutItem: { positioning: "absolute", widthSizing: "fill" },
				} as CanvasNode,
			]),
		]);
		const graph = buildSizingGraph(ir);

		expect(graph.effectiveSizing(findNode(ir, "r1"), "widthSizing")).toBe(
			"fixed",
		);
	});

	it("produces an identical graph across repeated builds", () => {
		// The "deterministic fallback" DoD. It holds by construction — the
		// demotion set is derived from an issue list that is already sorted by
		// the fully specified TD §14 key — and this pins that it stays true.
		const ir = docOf([
			frameWith(
				"f1",
				[
					{
						...createRect({ id: "r1", bounds: box }),
						layoutItem: { widthSizing: "fill" },
					} as CanvasNode,
					{
						...createText({ id: "t1", text: "hi", bounds: box }),
						layoutItem: { widthSizing: "fill" },
					} as CanvasNode,
				],
				{ layoutItem: { widthSizing: "hug" } },
			),
		]);
		const first = buildSizingGraph(ir);
		for (let i = 0; i < 5; i++) {
			expect(buildSizingGraph(ir).issues).toEqual(first.issues);
		}
	});

	it("derives demotion from the diagnostics, so the two cannot disagree", () => {
		// The design claim made executable: every demoted axis has a diagnostic
		// explaining it, and every demoting diagnostic demoted its axis. A second
		// hand-written rule set in the solver is exactly what this forbids.
		const ir = docOf([
			frameWith(
				"f1",
				[
					{
						...createRect({ id: "r1", bounds: box }),
						layoutItem: { widthSizing: "fill", heightSizing: "hug" },
					} as CanvasNode,
				],
				{ layoutItem: { widthSizing: "hug" } },
			),
		]);
		const graph = buildSizingGraph(ir);
		const rect = findNode(ir, "r1");
		const demotingCodes = new Set([
			"layout-fill-without-parent",
			"layout-hug-unsupported",
			"layout-circular-sizing",
		]);

		for (const field of ["widthSizing", "heightSizing"] as const) {
			const axis = field === "widthSizing" ? "horizontal" : "vertical";
			const hasDiagnostic = graph.issues.some(
				(i) =>
					i.nodeId === rect.id && i.axis === axis && demotingCodes.has(i.code),
			);
			expect(graph.wasDemoted(rect, field), field).toBe(hasDiagnostic);
		}
	});
});

describe("emptySizingGraph", () => {
	it("reports declared intent with no validation pass", () => {
		const node = {
			...createRect({ id: "r1", bounds: box }),
			layoutItem: { widthSizing: "hug" },
		} as CanvasNode;
		const graph = emptySizingGraph();

		expect(graph.issues).toEqual([]);
		expect(graph.wasDemoted(node, "widthSizing")).toBe(false);
		expect(graph.effectiveSizing(node, "widthSizing")).toBe("hug");
		expect(graph.effectiveSizing(node, "heightSizing")).toBe("fixed");
	});
});
