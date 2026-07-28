import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import { validateCanvasIRInvariants } from "../../ir/invariants.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import { MAX_RETAINED_DIAGNOSTICS, MAX_TREE_DEPTH } from "../../limits.js";
import { resolveCanvasLayout } from "../resolve.js";
import type { CanvasLayoutIssue } from "../validate.js";
import {
	buildDocumentOrder,
	orderLayoutIssues,
	validateLayoutInvariants,
} from "../validate.js";

/**
 * @file T-M2-06 — diagnostic ordering, emission rules and depth (TS-15, TS-47).
 */

const box = { width: 40, height: 20 };

const layout = {
	version: 1,
	direction: "horizontal",
	padding: { top: 0, right: 0, bottom: 0, left: 0 },
	gap: 0,
	primaryAlign: "start",
	crossAlign: "start",
} as const;

function frameWith(
	id: string,
	children: CanvasNode[],
	overrides: Record<string, unknown> = {},
): CanvasNode {
	return {
		...createFrame({ id, bounds: { width: 200, height: 100 } }),
		autoLayout: layout,
		children,
		...overrides,
	} as CanvasNode;
}

function docOf(children: CanvasNode[]): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	for (const child of children) {
		ir = insertNode(ir, { parentId: page.root.id, node: child });
	}
	return ir;
}

describe("buildDocumentOrder", () => {
	it("indexes every node in pre-order across pages", () => {
		const p1 = createPage({ id: "p1" });
		const p2 = createPage({ id: "p2" });
		let ir = createCanvasIR({ id: "d", title: "t", pages: [p1, p2] });
		ir = insertNode(ir, {
			parentId: p1.root.id,
			node: frameWith("f1", [createRect({ id: "a", bounds: box })]),
		});
		ir = insertNode(ir, {
			parentId: p2.root.id,
			node: createRect({ id: "b", bounds: box }),
		});

		const order = buildDocumentOrder(ir);

		expect(order.get("f1")?.pageIndex).toBe(0);
		expect(order.get("b")?.pageIndex).toBe(1);
		// Pre-order: a frame is visited before the child it contains.
		expect(order.get("f1")?.order).toBeLessThan(
			order.get("a")?.order as number,
		);
	});

	it("survives an over-deep document rather than refusing to order it", () => {
		let spine: CanvasNode = createFrame({ id: "deepest", bounds: box });
		for (let i = MAX_TREE_DEPTH + 4; i >= 0; i--) {
			spine = {
				...createFrame({ id: `f${i}`, bounds: box }),
				children: [spine],
			} as CanvasNode;
		}
		const page = createPage({ id: "p1" });
		const ir = createCanvasIR({
			id: "d",
			title: "t",
			pages: [{ ...page, root: { ...page.root, children: [spine] } }],
		});

		expect(() => buildDocumentOrder(ir)).not.toThrow();
		expect(buildDocumentOrder(ir).size).toBeGreaterThan(0);
	});
});

describe("orderLayoutIssues (TD §14 sort key)", () => {
	const order = new Map([
		["early", { pageIndex: 0, order: 1 }],
		["late", { pageIndex: 0, order: 2 }],
		["page2", { pageIndex: 1, order: 3 }],
	]);
	const issue = (
		over: Partial<CanvasLayoutIssue> & { code: CanvasLayoutIssue["code"] },
	): CanvasLayoutIssue =>
		({ severity: "warning", message: "", ...over }) as CanvasLayoutIssue;

	it("sorts by page, then pre-order, then axis, then code", () => {
		const sorted = orderLayoutIssues(
			[
				issue({ code: "layout-negative-gap", nodeId: "page2" }),
				issue({
					code: "layout-negative-gap",
					nodeId: "early",
					axis: "vertical",
				}),
				issue({
					code: "layout-negative-gap",
					nodeId: "early",
					axis: "horizontal",
				}),
				issue({ code: "layout-invalid-number", nodeId: "early" }),
				issue({ code: "layout-negative-gap", nodeId: "late" }),
			],
			order,
		);

		expect(sorted.map((i) => [i.nodeId, i.axis, i.code])).toEqual([
			// Axis-less sorts before both axes on the same node...
			["early", undefined, "layout-invalid-number"],
			["early", "horizontal", "layout-negative-gap"],
			["early", "vertical", "layout-negative-gap"],
			["late", undefined, "layout-negative-gap"],
			["page2", undefined, "layout-negative-gap"],
		]);
	});

	it("sorts document-scoped issues before every node-scoped one", () => {
		const sorted = orderLayoutIssues(
			[
				issue({ code: "layout-negative-gap", nodeId: "early" }),
				issue({ code: "layout-capability-unsupported" }),
			],
			order,
		);
		expect(sorted[0]?.code).toBe("layout-capability-unsupported");
	});

	it("compares codes by code unit, never by locale", () => {
		// A locale-sensitive collation would make diagnostic order depend on the
		// host's locale — the environment coupling AC-008's determinism forbids.
		const codes = [
			"layout-negative-padding",
			"layout-invalid-number",
			"layout-hug-unsupported",
		] as const;
		const sorted = orderLayoutIssues(
			codes.map((code) => issue({ code, nodeId: "early" })),
			order,
		);
		expect(sorted.map((i) => i.code)).toEqual([...codes].sort());
	});

	it("is stable for issues identical on all four key components", () => {
		const a = issue({
			code: "layout-negative-gap",
			nodeId: "early",
			message: "a",
		});
		const b = issue({
			code: "layout-negative-gap",
			nodeId: "early",
			message: "b",
		});
		expect(orderLayoutIssues([a, b], order).map((i) => i.message)).toEqual([
			"a",
			"b",
		]);
	});

	it("does not mutate its input", () => {
		const input = [
			issue({ code: "layout-negative-gap", nodeId: "late" }),
			issue({ code: "layout-negative-gap", nodeId: "early" }),
		];
		orderLayoutIssues(input, order);
		expect(input[0]?.nodeId).toBe("late");
	});
});

describe("resolver diagnostics are one ordered array (TS-15)", () => {
	// A document that produces BOTH kinds: level-3 invariants from the graph
	// and level-4 resolution diagnostics from the solver.
	const mixed = () =>
		docOf([
			frameWith(
				"f1",
				[
					{
						...createRect({ id: "a", bounds: { width: 300, height: 20 } }),
						layoutItem: { widthSizing: "hug" },
					} as CanvasNode,
					{
						...createText({ id: "t", text: "hi", bounds: box }),
						layoutItem: { widthSizing: "fill" },
					} as CanvasNode,
				],
				{},
			),
		]);

	it("merges validator and resolver issues into TD §14 order", () => {
		const resolved = resolveCanvasLayout(mixed(), {});
		const order = buildDocumentOrder(mixed());

		expect(resolved.diagnostics.length).toBeGreaterThan(1);
		// Concatenating the two sources would leave the array dependent on the
		// order the solver happened to visit nodes.
		expect(resolved.diagnostics).toEqual(
			orderLayoutIssues(resolved.diagnostics, order),
		);
	});

	it("is byte-identical in order AND length across repeated resolutions", () => {
		const ir = mixed();
		const first = resolveCanvasLayout(ir, {});
		for (let i = 0; i < 6; i++) {
			const again = resolveCanvasLayout(ir, {});
			expect(again.diagnostics).toEqual(first.diagnostics);
			expect(again.truncatedDiagnostics).toBe(first.truncatedDiagnostics);
		}
	});

	it("keeps every validator issue reachable through the resolved document", () => {
		const ir = mixed();
		const validatorCodes = new Set(
			validateLayoutInvariants(ir).map((i) => i.code),
		);
		const resolvedCodes = new Set(
			resolveCanvasLayout(ir, {}).diagnostics.map((i) => i.code),
		);
		for (const code of validatorCodes) {
			expect(resolvedCodes, code).toContain(code);
		}
	});
});

describe("depth is reported by two codes at two layers (TS-47)", () => {
	function deepDocument(): CanvasIR {
		let spine: CanvasNode = createFrame({ id: "deepest", bounds: box });
		for (let i = MAX_TREE_DEPTH + 4; i >= 0; i--) {
			spine = {
				...createFrame({ id: `f${i}`, bounds: box }),
				children: [spine],
			} as CanvasNode;
		}
		const page = createPage({ id: "p1" });
		return createCanvasIR({
			id: "d",
			title: "t",
			pages: [{ ...page, root: { ...page.root, children: [spine] } }],
		});
	}

	it("emits layout-depth-exceeded from the resolver without throwing", () => {
		const ir = deepDocument();
		expect(() => resolveCanvasLayout(ir, {})).not.toThrow();
		expect(
			resolveCanvasLayout(ir, {}).diagnostics.map((d) => d.code),
		).toContain("layout-depth-exceeded");
	});

	it("still returns usable geometry for the part above the cut", () => {
		// "Stop descending", not "give up": everything shallower than the cut
		// resolves normally, so the document stays editable.
		const resolved = resolveCanvasLayout(deepDocument(), {});
		expect(resolved.records.size).toBeGreaterThan(MAX_TREE_DEPTH - 1);
		expect(resolved.records.get("f0" as never)).toBeDefined();
	});

	it("leaves excessive-tree-depth to the invariant pass, as a complement", () => {
		// The two codes are complementary, not duplicate: `excessive-tree-depth`
		// is the document-level fact ("this tree is too deep"), and
		// `layout-depth-exceeded` is the resolution-level consequence ("layout
		// below this node was not computed"). One document produces BOTH — so
		// asserting only that the layout pass omits one would leave the
		// "complementary" half of the claim untested.
		const ir = deepDocument();
		const layoutCodes = validateLayoutInvariants(ir).map((i) => i.code);
		const documentCodes = validateCanvasIRInvariants(ir).map((i) => i.code);

		expect(layoutCodes).toContain("layout-depth-exceeded");
		expect(layoutCodes).not.toContain("excessive-tree-depth");
		expect(documentCodes).toContain("excessive-tree-depth");
		expect(documentCodes).not.toContain("layout-depth-exceeded");
	});
});

describe("diagnostic truncation is never silent", () => {
	it("reports zero dropped for an ordinary document", () => {
		const resolved = resolveCanvasLayout(
			docOf([frameWith("f1", [createRect({ id: "a", bounds: box })])]),
			{},
		);
		expect(resolved.truncatedDiagnostics).toBe(0);
	});

	it("caps the retained list and reports how many were dropped", () => {
		// Diagnostics are emitted per offending node, so a systematically broken
		// document produces one per node. Build more than the cap.
		const overflow = 25;
		const children: CanvasNode[] = [];
		for (let i = 0; i < MAX_RETAINED_DIAGNOSTICS + overflow; i++) {
			children.push({
				...createRect({ id: `r${i}`, bounds: box }),
				// Fill with no Auto Layout parent → one issue per node.
				layoutItem: { widthSizing: "fill" },
			} as CanvasNode);
		}
		const resolved = resolveCanvasLayout(docOf(children), {});

		expect(resolved.diagnostics).toHaveLength(MAX_RETAINED_DIAGNOSTICS);
		expect(resolved.truncatedDiagnostics).toBe(overflow);
	});

	it("retains the prefix of the normative order, deterministically", () => {
		const children: CanvasNode[] = [];
		for (let i = 0; i < MAX_RETAINED_DIAGNOSTICS + 5; i++) {
			children.push({
				...createRect({ id: `r${i}`, bounds: box }),
				layoutItem: { widthSizing: "fill" },
			} as CanvasNode);
		}
		const ir = docOf(children);
		const first = resolveCanvasLayout(ir, {});
		const again = resolveCanvasLayout(ir, {});

		expect(again.diagnostics).toEqual(first.diagnostics);
		// Prefix in document order, so the first offending node is retained and
		// the last is the one dropped.
		expect(first.diagnostics[0]?.nodeId).toBe("r0");
	});
});
