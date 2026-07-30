/**
 * T-CMD-1 (plan 0023 M3-01): the SAME mutation helpers operate on a page
 * tree and a Component Source tree through one engine — `location` only
 * picks the tree. Covers structural parity, Source write-back semantics
 * (no revision bump, `updatedAt` bumped, layout stamp dropped, pages
 * untouched), root guards on both paths, and the depth guard.
 */

import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../builders.js";
import {
	CanvasIRMutationError,
	insertNode,
	moveNode,
	removeNode,
	reorderChildren,
	replaceChildrenInParent,
	replaceNode,
	updateNode,
} from "../mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasIR,
	CanvasRectNode,
} from "../types.js";
import { CanvasIRDepthError, MAX_TREE_DEPTH } from "../walkers.js";

const NOW = () => "2026-07-29T00:00:00.000Z";
const LATER = () => "2026-07-30T00:00:00.000Z";

function definition(ir: CanvasIR, componentId: string) {
	const def = ir.components?.[componentId];
	if (!def) throw new Error(`missing definition ${componentId}`);
	return def;
}

function definitionRoot(ir: CanvasIR, componentId: string) {
	return definition(ir, componentId).root as CanvasFrameNode;
}

function pageRoot(ir: CanvasIR): CanvasGroupNode {
	const root = ir.pages[0]?.root;
	if (!root) throw new Error("missing page root");
	return root;
}

function sampleIR(): CanvasIR {
	const pageRect = createRect({
		id: "r1",
		bounds: { width: 10, height: 10 },
		fill: "#f00",
	});
	const pageText = createText({
		id: "t1",
		bounds: { width: 100, height: 24 },
		text: "hi",
	});
	const pageInner = createGroup({
		id: "g1",
		bounds: { width: 50, height: 50 },
		children: [pageText],
	});
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children: [pageRect, pageInner],
	});

	const defRect = createRect({
		id: "c1",
		bounds: { width: 10, height: 10 },
		fill: "#00f",
	});
	const defText = createText({
		id: "ct1",
		bounds: { width: 80, height: 20 },
		text: "cta",
	});
	const defInner = createGroup({
		id: "cg",
		bounds: { width: 40, height: 40 },
		children: [defText],
	});
	const definition: CanvasComponentDefinition = {
		id: "cmp-a",
		name: "Card",
		revision: 3,
		root: createFrame({
			id: "croot",
			bounds: { width: 120, height: 90 },
			children: [defRect, defInner],
		}),
		properties: [],
	};
	const leafDefinition: CanvasComponentDefinition = {
		id: "cmp-leaf",
		name: "Dot",
		revision: 1,
		root: createRect({ id: "leaf-root", bounds: { width: 4, height: 4 } }),
		properties: [],
	};

	const ir = createCanvasIR({ id: "ir-1", pages: [page], now: NOW });
	return {
		...ir,
		components: { "cmp-a": definition, "cmp-leaf": leafDefinition },
		layoutMaterialization: {
			engineVersion: 1,
			inputHash: "test",
			resolvedAtRevision: 0,
		},
	};
}

describe("scoped mutations — Source write-back semantics", () => {
	it("insertNode into a definition updates ONLY the registry: revision unchanged, updatedAt bumped, layout stamp dropped, pages untouched", () => {
		const ir = sampleIR();
		const added = createRect({ id: "c-new", bounds: { width: 5, height: 5 } });
		const next = insertNode(ir, {
			parentId: "croot",
			node: added,
			location: { kind: "component", id: "cmp-a" },
			now: LATER,
		});
		expect(definition(next, "cmp-a").revision).toBe(3);
		expect(definitionRoot(next, "cmp-a").children.map((c) => c.id)).toEqual([
			"c1",
			"cg",
			"c-new",
		]);
		expect(next.metadata.updatedAt).toBe(LATER());
		expect(next.layoutMaterialization).toBeUndefined();
		expect(next.pages).toBe(ir.pages);
		expect(next.components?.["cmp-leaf"]).toBe(ir.components?.["cmp-leaf"]);
		// The input document is never mutated (INV-4 at the primitive layer).
		expect(definitionRoot(ir, "cmp-a").children).toHaveLength(2);
	});

	it("a page-located mutation leaves the registry reference untouched", () => {
		const ir = sampleIR();
		const added = createRect({ id: "p-new", bounds: { width: 5, height: 5 } });
		const next = insertNode(ir, {
			parentId: "pg-root",
			node: added,
			location: { kind: "page", id: "p1" },
		});
		expect(next.components).toBe(ir.components);
		const root = next.pages[0]?.root as CanvasGroupNode;
		expect(root.children.map((c) => c.id)).toEqual(["r1", "g1", "p-new"]);
	});

	it("throws location-not-found for a missing page or definition", () => {
		const ir = sampleIR();
		for (const location of [
			{ kind: "page", id: "nope" } as const,
			{ kind: "component", id: "nope" } as const,
		]) {
			try {
				removeNode(ir, { id: "r1", location });
				expect.unreachable();
			} catch (err) {
				expect(err).toBeInstanceOf(CanvasIRMutationError);
				expect((err as CanvasIRMutationError).code).toBe("location-not-found");
			}
		}
	});
});

describe("scoped mutations — T-CMD-1 page/definition parity", () => {
	it("removeNode removes the same shape from either tree", () => {
		const ir = sampleIR();
		const pageNext = removeNode(ir, {
			id: "r1",
			location: { kind: "page", id: "p1" },
		});
		const defNext = removeNode(ir, {
			id: "c1",
			location: { kind: "component", id: "cmp-a" },
		});
		expect(pageRoot(pageNext).children.map((c) => c.id)).toEqual(["g1"]);
		expect(definitionRoot(defNext, "cmp-a").children.map((c) => c.id)).toEqual([
			"cg",
		]);
	});

	it("updateNode patches identically in either tree, including the definition root itself", () => {
		const ir = sampleIR();
		const pageNext = updateNode(ir, {
			id: "r1",
			kind: "rect",
			patch: { fill: "#123456" },
			location: { kind: "page", id: "p1" },
		});
		const defNext = updateNode(ir, {
			id: "c1",
			kind: "rect",
			patch: { fill: "#123456" },
			location: { kind: "component", id: "cmp-a" },
		});
		const pageRect = pageRoot(pageNext).children[0] as CanvasRectNode;
		const defRect = definitionRoot(defNext, "cmp-a")
			.children[0] as CanvasRectNode;
		expect(pageRect.fill).toBe("#123456");
		expect(defRect.fill).toBe("#123456");

		const rootPatched = updateNode(ir, {
			id: "croot",
			kind: "frame",
			patch: { name: "Card root" },
			location: { kind: "component", id: "cmp-a" },
		});
		expect(definitionRoot(rootPatched, "cmp-a").name).toBe("Card root");
		expect(definitionRoot(rootPatched, "cmp-a").type).toBe("frame");

		// A leaf Source root is patchable too — no container requirement.
		const leafPatched = updateNode(ir, {
			id: "leaf-root",
			kind: "rect",
			patch: { fill: "#fff" },
			location: { kind: "component", id: "cmp-leaf" },
		});
		expect(
			(definition(leafPatched, "cmp-leaf").root as CanvasRectNode).fill,
		).toBe("#fff");
	});

	it("moveNode reparents within a definition tree exactly like a page tree", () => {
		const ir = sampleIR();
		const pageNext = moveNode(ir, {
			id: "r1",
			newParentId: "g1",
			index: 0,
			location: { kind: "page", id: "p1" },
		});
		const defNext = moveNode(ir, {
			id: "c1",
			newParentId: "cg",
			index: 0,
			location: { kind: "component", id: "cmp-a" },
		});
		const pageInner = pageRoot(pageNext).children[0] as CanvasGroupNode;
		expect(pageInner.id).toBe("g1");
		expect(pageInner.children.map((c) => c.id)).toEqual(["r1", "t1"]);
		const defInner = definitionRoot(defNext, "cmp-a")
			.children[0] as CanvasGroupNode;
		expect(defInner.id).toBe("cg");
		expect(defInner.children.map((c) => c.id)).toEqual(["c1", "ct1"]);
	});

	it("reorderChildren + replaceChildrenInParent behave identically in a definition", () => {
		const ir = sampleIR();
		const reordered = reorderChildren(ir, {
			parentId: "croot",
			fromIndex: 0,
			toIndex: 1,
			location: { kind: "component", id: "cmp-a" },
		});
		expect(
			definitionRoot(reordered, "cmp-a").children.map((c) => c.id),
		).toEqual(["cg", "c1"]);

		const replaced = replaceChildrenInParent(ir, {
			parentId: "croot",
			replace: (children) => [...children].reverse(),
			location: { kind: "component", id: "cmp-a" },
		});
		expect(definitionRoot(replaced, "cmp-a").children.map((c) => c.id)).toEqual(
			["cg", "c1"],
		);
	});

	it("replaceNode swaps a node (id and kind may change) in either tree, and may replace a Source root wholesale", () => {
		const ir = sampleIR();
		const swap = createText({
			id: "swapped",
			bounds: { width: 30, height: 12 },
			text: "x",
		});
		const pageNext = replaceNode(ir, {
			id: "r1",
			node: swap,
			location: { kind: "page", id: "p1" },
		});
		expect(pageRoot(pageNext).children.map((c) => c.id)).toEqual([
			"swapped",
			"g1",
		]);
		const defNext = replaceNode(ir, {
			id: "c1",
			node: swap,
			location: { kind: "component", id: "cmp-a" },
		});
		expect(definitionRoot(defNext, "cmp-a").children.map((c) => c.id)).toEqual([
			"swapped",
			"cg",
		]);

		const newRoot = createFrame({
			id: "new-root",
			bounds: { width: 8, height: 8 },
		});
		const rootSwapped = replaceNode(ir, {
			id: "leaf-root",
			node: newRoot,
			location: { kind: "component", id: "cmp-leaf" },
		});
		expect(rootSwapped.components?.["cmp-leaf"]?.root.id).toBe("new-root");
		expect(rootSwapped.components?.["cmp-leaf"]?.revision).toBe(1);
	});
});

describe("scoped mutations — root and depth guards on the Source path", () => {
	it("rejects removing or moving a Source root with typed codes", () => {
		const ir = sampleIR();
		expect(() =>
			removeNode(ir, {
				id: "croot",
				location: { kind: "component", id: "cmp-a" },
			}),
		).toThrowError(
			expect.objectContaining({ code: "cannot-remove-source-root" }),
		);
		expect(() =>
			moveNode(ir, {
				id: "croot",
				newParentId: "cg",
				location: { kind: "component", id: "cmp-a" },
			}),
		).toThrowError(
			expect.objectContaining({ code: "cannot-move-source-root" }),
		);
	});

	it("keeps the page-root guards byte-identical for unscoped calls", () => {
		const ir = sampleIR();
		expect(() => removeNode(ir, { id: "pg-root" })).toThrowError(
			'Cannot remove page-root group "pg-root"',
		);
		expect(() =>
			moveNode(ir, { id: "pg-root", newParentId: "g1" }),
		).toThrowError('Cannot move page-root group "pg-root"');
	});

	it("rejects replacing a page root with a non-group but allows a group", () => {
		const ir = sampleIR();
		expect(() =>
			replaceNode(ir, {
				id: "pg-root",
				node: createRect({ id: "bad", bounds: { width: 1, height: 1 } }),
				location: { kind: "page", id: "p1" },
			}),
		).toThrowError(
			expect.objectContaining({ code: "invalid-root-replacement" }),
		);
		const nextRoot = createGroup({
			id: "pg-root-2",
			bounds: { width: 1, height: 1 },
		});
		const next = replaceNode(ir, {
			id: "pg-root",
			node: nextRoot,
			location: { kind: "page", id: "p1" },
		});
		expect(next.pages[0]?.root.id).toBe("pg-root-2");
	});

	it("a leaf Source root rejects child inserts as parent-not-group", () => {
		const ir = sampleIR();
		expect(() =>
			insertNode(ir, {
				parentId: "leaf-root",
				node: createRect({ id: "x", bounds: { width: 1, height: 1 } }),
				location: { kind: "component", id: "cmp-leaf" },
			}),
		).toThrowError(expect.objectContaining({ code: "parent-not-group" }));
	});

	it("enforces MAX_TREE_DEPTH when a replacement subtree would exceed it", () => {
		const ir = sampleIR();
		// A chain deep enough that splicing it at depth 1 busts the budget.
		let chain = createGroup({
			id: "chain-0",
			bounds: { width: 1, height: 1 },
		});
		for (let i = 1; i <= MAX_TREE_DEPTH; i++) {
			chain = createGroup({
				id: `chain-${i}`,
				bounds: { width: 1, height: 1 },
				children: [chain],
			});
		}
		expect(() =>
			replaceNode(ir, {
				id: "c1",
				node: chain,
				location: { kind: "component", id: "cmp-a" },
			}),
		).toThrowError(CanvasIRDepthError);
	});

	it("replaces pages by identity, not id: duplicate page ids never get clobbered into one tree", () => {
		// A hostile document can carry duplicate page ids; the invariant layer
		// flags them but mutations must still touch exactly ONE page (the legacy
		// positional semantics). Regression: an id-keyed page replacement wrote
		// the first page's tree over every same-id page.
		const page1 = createPage({ id: "dup" });
		page1.root = createGroup({
			id: "dup-root-1",
			bounds: page1.root.bounds,
			children: [],
		});
		const page2 = createPage({ id: "dup" });
		page2.root = createGroup({
			id: "dup-root-2",
			bounds: page2.root.bounds,
			children: [],
		});
		const ir = createCanvasIR({
			id: "ir-dup",
			pages: [page1, page2],
			now: NOW,
		});
		const next = insertNode(ir, {
			parentId: "dup-root-1",
			node: createRect({ id: "only-once", bounds: { width: 1, height: 1 } }),
		});
		expect((next.pages[0]?.root.children ?? []).map((c) => c.id)).toEqual([
			"only-once",
		]);
		expect(next.pages[1]?.root.children ?? []).toHaveLength(0);
		expect(next.pages[1]).toBe(ir.pages[1]);
	});

	it("scoping to one tree never finds ids from another tree", () => {
		const ir = sampleIR();
		expect(() =>
			removeNode(ir, { id: "c1", location: { kind: "page", id: "p1" } }),
		).toThrowError(expect.objectContaining({ code: "node-not-found" }));
		expect(() =>
			removeNode(ir, {
				id: "r1",
				location: { kind: "component", id: "cmp-a" },
			}),
		).toThrowError(expect.objectContaining({ code: "node-not-found" }));
		// Unscoped calls remain pages-only by contract: Source nodes are invisible.
		expect(() => removeNode(ir, { id: "c1" })).toThrowError(
			expect.objectContaining({ code: "node-not-found" }),
		);
	});
});
