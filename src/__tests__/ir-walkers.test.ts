import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../ir-builders.js";
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
} from "../ir-walkers.js";
import type { CanvasGroupNode, CanvasNode } from "../types.js";

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
