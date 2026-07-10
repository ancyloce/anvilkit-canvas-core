import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../builders.js";
import { insertNode } from "../mutations.js";
import type { CanvasGroupNode, CanvasNode } from "../types.js";
import {
	CanvasIRDepthError,
	findNode,
	isGroupNode,
	isLeafNode,
	isNodeOfKind,
	MAX_TREE_DEPTH,
	pageOf,
	parentOf,
	walk,
} from "../walkers.js";

function buildSampleIR() {
	const rect = createRect({
		id: "rect-1",
		bounds: { width: 10, height: 10 },
	});
	const text = createText({
		id: "text-1",
		bounds: { width: 100, height: 24 },
		text: "hi",
	});
	const innerGroup = createGroup({
		id: "inner-group",
		children: [text],
	});
	const outerGroup = createGroup({
		id: "outer-group",
		children: [rect, innerGroup],
	});
	const page = createPage({ id: "page-1" });
	page.root = createGroup({
		id: "page-root",
		bounds: page.root.bounds,
		children: [outerGroup],
	});
	const page2 = createPage({ id: "page-2" });
	const ir = createCanvasIR({ id: "ir-1", pages: [page, page2] });
	return { ir, rect, text, innerGroup, outerGroup, page, page2 };
}

describe("walk", () => {
	it("visits every node in pre-order across pages", () => {
		const { ir, rect, text, innerGroup, outerGroup, page, page2 } =
			buildSampleIR();
		const order: string[] = [];
		walk(ir, ({ node, depth }) => {
			order.push(`${node.id}@${depth}`);
		});
		expect(order).toEqual([
			"page-root@0",
			`${outerGroup.id}@1`,
			`${rect.id}@2`,
			`${innerGroup.id}@2`,
			`${text.id}@3`,
			`${page2.root.id}@0`,
		]);
		// Ensures page param is correct
		const seenPageIds = new Set<string>();
		walk(ir, ({ page }) => {
			seenPageIds.add(page.id);
		});
		expect(seenPageIds).toEqual(new Set([page.id, page2.id]));
	});

	it("provides parent === null at the page root and the parent group otherwise", () => {
		const { ir, rect, outerGroup } = buildSampleIR();
		const rectParent = new Map<string, CanvasNode | null>();
		walk(ir, ({ node, parent }) => {
			rectParent.set(node.id, parent);
		});
		expect(rectParent.get("page-root")).toBeNull();
		expect(rectParent.get(rect.id)?.id).toBe(outerGroup.id);
	});
});

describe("findNode", () => {
	it("returns the node + its page for a known id", () => {
		const { ir, rect, page } = buildSampleIR();
		const result = findNode(ir, rect.id);
		expect(result).not.toBeNull();
		expect(result?.node.id).toBe(rect.id);
		expect(result?.page.id).toBe(page.id);
	});

	it("returns null for an unknown id", () => {
		const { ir } = buildSampleIR();
		expect(findNode(ir, "missing")).toBeNull();
	});
});

describe("parentOf", () => {
	it("returns the wrapping group for a leaf", () => {
		const { ir, text, innerGroup } = buildSampleIR();
		const result = parentOf(ir, text.id);
		expect(result?.parent.id).toBe(innerGroup.id);
	});

	it("returns null for the page root group", () => {
		const { ir } = buildSampleIR();
		expect(parentOf(ir, "page-root")).toBeNull();
	});

	it("returns null for an unknown id", () => {
		const { ir } = buildSampleIR();
		expect(parentOf(ir, "missing")).toBeNull();
	});
});

describe("pageOf", () => {
	it("returns the right page for a deeply-nested node", () => {
		const { ir, text, page } = buildSampleIR();
		expect(pageOf(ir, text.id)?.id).toBe(page.id);
	});

	it("returns null for an unknown id", () => {
		const { ir } = buildSampleIR();
		expect(pageOf(ir, "missing")).toBeNull();
	});
});

describe("type guards", () => {
	it("isGroupNode narrows the union", () => {
		const { outerGroup, rect } = buildSampleIR();
		expect(isGroupNode(outerGroup)).toBe(true);
		expect(isGroupNode(rect)).toBe(false);
	});

	it("isLeafNode narrows the union", () => {
		const { outerGroup, rect } = buildSampleIR();
		expect(isLeafNode(rect)).toBe(true);
		expect(isLeafNode(outerGroup)).toBe(false);
	});

	it("isNodeOfKind narrows to the specified kind", () => {
		const { text } = buildSampleIR();
		expect(isNodeOfKind(text, "text")).toBe(true);
		expect(isNodeOfKind(text, "rect")).toBe(false);
	});
});

describe("node lookup resolution", () => {
	it("is isolated per IR version: a mutation's new IR sees the change, the prior IR does not", () => {
		const { ir, outerGroup } = buildSampleIR();
		expect(findNode(ir, outerGroup.id)?.node.id).toBe(outerGroup.id);
		expect(findNode(ir, "added-rect")).toBeNull();

		const added = createRect({
			id: "added-rect",
			bounds: { width: 5, height: 5 },
		});
		const next = insertNode(ir, { parentId: outerGroup.id, node: added });

		// The new IR resolves the inserted node...
		expect(findNode(next, "added-rect")?.node.id).toBe("added-rect");
		expect(parentOf(next, "added-rect")?.parent.id).toBe(outerGroup.id);
		expect(pageOf(next, "added-rect")?.id).toBe("page-1");
		// ...and the prior (immutable) IR is unaffected — no cross-version leak.
		expect(findNode(ir, "added-rect")).toBeNull();
	});

	it("resolves consistently across repeated lookups and returns the live tree node", () => {
		const { ir, text, innerGroup, page } = buildSampleIR();
		for (let i = 0; i < 3; i += 1) {
			expect(findNode(ir, text.id)?.node.id).toBe(text.id);
			expect(parentOf(ir, text.id)?.parent.id).toBe(innerGroup.id);
			expect(pageOf(ir, text.id)?.id).toBe(page.id);
		}
		// Identity is preserved: the resolved node is the live tree node.
		expect(findNode(ir, text.id)?.node).toBe(text);
	});

	it("resolves the first pre-order occurrence when an id is duplicated", () => {
		const dupChild = createRect({
			id: "dup",
			bounds: { width: 1, height: 1 },
		});
		const dupGroup = createGroup({ id: "dup", children: [dupChild] });
		const page = createPage({ id: "p-dup" });
		page.root = createGroup({
			id: "p-dup-root",
			bounds: page.root.bounds,
			children: [dupGroup],
		});
		const ir = createCanvasIR({ pages: [page] });
		// Pre-order visits the group before its child, so the group wins.
		expect(findNode(ir, "dup")?.node.type).toBe("group");
	});

	it("findNode throws CanvasIRDepthError on a tree past MAX_TREE_DEPTH", () => {
		let leaf: CanvasGroupNode = createGroup({
			id: "leaf",
			bounds: { width: 0, height: 0 },
		});
		for (let i = MAX_TREE_DEPTH + 1; i >= 0; i--) {
			leaf = createGroup({
				id: `g-${i}`,
				bounds: { width: 0, height: 0 },
				children: [leaf],
			});
		}
		const page = createPage({ id: "p-deep" });
		page.root = leaf;
		const ir = createCanvasIR({ pages: [page] });
		expect(() => findNode(ir, "leaf")).toThrow(CanvasIRDepthError);
	});
});

describe("CanvasIRDepthError", () => {
	it("throws when a synthesized chain exceeds MAX_TREE_DEPTH", () => {
		// Build a chain of MAX_TREE_DEPTH+2 nested groups (bypass builders to skip
		// any future depth assertions in the builder layer).
		let leaf: CanvasGroupNode = createGroup({
			id: "leaf",
			bounds: { width: 0, height: 0 },
		});
		for (let i = MAX_TREE_DEPTH + 1; i >= 0; i--) {
			leaf = createGroup({
				id: `g-${i}`,
				bounds: { width: 0, height: 0 },
				children: [leaf],
			});
		}
		const page = createPage({ id: "p1" });
		page.root = leaf;
		const ir = createCanvasIR({ pages: [page] });
		expect(() =>
			walk(ir, () => {
				// no-op visitor; depth assertion is in walkSubtree
			}),
		).toThrow(CanvasIRDepthError);
		try {
			walk(ir, () => {
				// no-op visitor; depth assertion is in walkSubtree
			});
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasIRDepthError);
			expect((err as CanvasIRDepthError).idChain.length).toBeGreaterThan(0);
		}
	});
});
