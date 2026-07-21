import { beforeEach, describe, expect, it } from "vitest";
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
	updateNode,
} from "../mutations.js";
import type {
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasRectNode,
} from "../types.js";
import {
	CanvasIRDepthError,
	findNode,
	isContainerNode,
	MAX_TREE_DEPTH,
} from "../walkers.js";

let counter = 0;
function tick(): string {
	counter++;
	return new Date(2026, 0, counter).toISOString();
}

beforeEach(() => {
	counter = 0;
});

function sampleIR() {
	const rectA = createRect({
		id: "rectA",
		bounds: { width: 10, height: 10 },
		fill: "#f00",
	});
	const rectB = createRect({
		id: "rectB",
		bounds: { width: 10, height: 10 },
		fill: "#0f0",
	});
	const text1 = createText({
		id: "text1",
		bounds: { width: 100, height: 24 },
		text: "hi",
	});
	const innerGroup = createGroup({
		id: "inner",
		bounds: { width: 50, height: 50 },
		children: [text1],
	});
	const outerGroup = createGroup({
		id: "outer",
		bounds: { width: 200, height: 200 },
		children: [rectA, innerGroup, rectB],
	});
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "page-root",
		bounds: page.root.bounds,
		children: [outerGroup],
	});
	return createCanvasIR({
		id: "ir-1",
		pages: [page],
		now: () => "2026-01-01T00:00:00.000Z",
	});
}

function snapshot(ir: CanvasIR): CanvasIR {
	return JSON.parse(JSON.stringify(ir));
}

/**
 * page-root > frame("frame-1") > [rectF, group("inner-f") > [textF]]
 * The mirror of `sampleIR`'s group tree, with a frame standing in for the outer
 * group — so every mutation below asserts frame children behave exactly like
 * group children.
 */
function frameIR() {
	const rectF = createRect({
		id: "rectF",
		bounds: { width: 10, height: 10 },
		fill: "#f00",
	});
	const textF = createText({
		id: "textF",
		bounds: { width: 100, height: 24 },
		text: "hi",
	});
	const innerF = createGroup({
		id: "inner-f",
		bounds: { width: 50, height: 50 },
		children: [textF],
	});
	const frame = createFrame({
		id: "frame-1",
		bounds: { width: 400, height: 400 },
		children: [rectF, innerF],
	});
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "page-root",
		bounds: page.root.bounds,
		children: [frame],
	});
	return createCanvasIR({
		id: "ir-1",
		pages: [page],
		now: () => "2026-01-01T00:00:00.000Z",
	});
}

function childIds(ir: CanvasIR, parentId: string): string[] {
	const parent = findNode(ir, parentId)?.node;
	if (!parent || !isContainerNode(parent)) {
		throw new Error(`${parentId} is not a container`);
	}
	return parent.children.map((c) => c.id);
}

describe("frame containers — mutations treat frame children like group children", () => {
	it("insertNode appends into a frame", () => {
		const ir = frameIR();
		const node = createRect({ id: "new", bounds: { width: 1, height: 1 } });
		const next = insertNode(ir, { parentId: "frame-1", node, now: tick });
		expect(childIds(next, "frame-1")).toEqual(["rectF", "inner-f", "new"]);
		// Pure: the source IR is untouched.
		expect(childIds(ir, "frame-1")).toEqual(["rectF", "inner-f"]);
	});

	it("insertNode honours an index inside a frame", () => {
		const ir = frameIR();
		const node = createRect({ id: "new", bounds: { width: 1, height: 1 } });
		const next = insertNode(ir, {
			parentId: "frame-1",
			node,
			index: 1,
			now: tick,
		});
		expect(childIds(next, "frame-1")).toEqual(["rectF", "new", "inner-f"]);
	});

	it("insertNode rejects an out-of-range index on a frame", () => {
		const ir = frameIR();
		const node = createRect({ id: "new", bounds: { width: 1, height: 1 } });
		try {
			insertNode(ir, { parentId: "frame-1", node, index: 99, now: tick });
			expect.unreachable("insert past the end must throw");
		} catch (err) {
			expect((err as CanvasIRMutationError).code).toBe("index-out-of-range");
		}
	});

	it("insertNode reaches a group nested INSIDE a frame", () => {
		const ir = frameIR();
		const node = createRect({ id: "new", bounds: { width: 1, height: 1 } });
		const next = insertNode(ir, { parentId: "inner-f", node, now: tick });
		expect(childIds(next, "inner-f")).toEqual(["textF", "new"]);
	});

	it("removeNode removes a direct frame child", () => {
		const ir = frameIR();
		const next = removeNode(ir, { id: "rectF", now: tick });
		expect(childIds(next, "frame-1")).toEqual(["inner-f"]);
	});

	it("removeNode removes a node nested deep inside a frame", () => {
		const ir = frameIR();
		const next = removeNode(ir, { id: "textF", now: tick });
		expect(childIds(next, "inner-f")).toEqual([]);
		expect(findNode(next, "textF")).toBeNull();
	});

	it("removeNode removes the frame itself, taking its subtree with it", () => {
		const ir = frameIR();
		const next = removeNode(ir, { id: "frame-1", now: tick });
		expect(childIds(next, "page-root")).toEqual([]);
		expect(findNode(next, "textF")).toBeNull();
	});

	it("updateNode patches a node inside a frame", () => {
		const ir = frameIR();
		const next = updateNode(ir, {
			id: "rectF",
			patch: { fill: "#0f0" },
			now: tick,
		});
		const rect = findNode(next, "rectF")?.node as CanvasRectNode | undefined;
		expect(rect?.fill).toBe("#0f0");
	});

	it("updateNode patches the frame's own fields and keeps the discriminant", () => {
		const ir = frameIR();
		const next = updateNode(ir, {
			id: "frame-1",
			patch: { clip: true, radius: 8 },
			now: tick,
		});
		const frame = findNode(next, "frame-1")?.node as CanvasFrameNode;
		expect(frame.type).toBe("frame");
		expect(frame.clip).toBe(true);
		expect(frame.radius).toBe(8);
		// Children survive a patch that doesn't mention them.
		expect(frame.children.map((c) => c.id)).toEqual(["rectF", "inner-f"]);
	});

	it("reorderChildren reorders a frame's children", () => {
		const ir = frameIR();
		const next = reorderChildren(ir, {
			parentId: "frame-1",
			fromIndex: 0,
			toIndex: 1,
			now: tick,
		});
		expect(childIds(next, "frame-1")).toEqual(["inner-f", "rectF"]);
	});

	it("moveNode moves a node OUT of a frame", () => {
		const ir = frameIR();
		const next = moveNode(ir, {
			id: "rectF",
			newParentId: "page-root",
			now: tick,
		});
		expect(childIds(next, "frame-1")).toEqual(["inner-f"]);
		expect(childIds(next, "page-root")).toEqual(["frame-1", "rectF"]);
	});

	it("moveNode moves a node INTO a frame (frame is a valid parent)", () => {
		const ir = frameIR();
		const next = moveNode(ir, {
			id: "textF",
			newParentId: "frame-1",
			index: 0,
			now: tick,
		});
		expect(childIds(next, "frame-1")).toEqual(["textF", "rectF", "inner-f"]);
		expect(childIds(next, "inner-f")).toEqual([]);
	});

	it("moveNode rejects moving a frame into its own descendant (cycle)", () => {
		const ir = frameIR();
		try {
			moveNode(ir, { id: "frame-1", newParentId: "inner-f", now: tick });
			expect.unreachable("moving a frame into its own child must throw");
		} catch (err) {
			expect((err as CanvasIRMutationError).code).toBe("cycle-detected");
		}
	});

	it("replaceChildrenInParent rewrites a frame's children in one pass", () => {
		const ir = frameIR();
		const next = replaceChildrenInParent(ir, {
			parentId: "frame-1",
			replace: (children) => [...children].reverse(),
			now: tick,
		});
		expect(childIds(next, "frame-1")).toEqual(["inner-f", "rectF"]);
	});
});

describe("insertNode", () => {
	it("appends to the parent by default and is pure", () => {
		const ir = sampleIR();
		const before = snapshot(ir);
		const newRect = createRect({
			id: "newRect",
			bounds: { width: 5, height: 5 },
		});
		const after = insertNode(ir, {
			parentId: "outer",
			node: newRect,
			now: tick,
		});
		expect(ir).toEqual(before);
		expect(after).not.toBe(ir);
		const outerAfter = findNode(after, "outer");
		expect(outerAfter?.node.type).toBe("group");
		if (outerAfter?.node.type === "group") {
			expect(outerAfter.node.children.at(-1)?.id).toBe("newRect");
		}
	});

	it("inserts at index 0 (prepend)", () => {
		const ir = sampleIR();
		const newRect = createRect({
			id: "newRect",
			bounds: { width: 5, height: 5 },
		});
		const after = insertNode(ir, {
			parentId: "outer",
			node: newRect,
			index: 0,
			now: tick,
		});
		const outer = findNode(after, "outer");
		if (outer?.node.type === "group") {
			expect(outer.node.children[0]?.id).toBe("newRect");
		}
	});

	it("throws node-not-found when parentId is unknown", () => {
		const ir = sampleIR();
		expect(() =>
			insertNode(ir, {
				parentId: "missing",
				node: createRect({ id: "x", bounds: { width: 1, height: 1 } }),
			}),
		).toThrow(CanvasIRMutationError);
	});

	it("throws parent-not-group when targeting a leaf", () => {
		const ir = sampleIR();
		try {
			insertNode(ir, {
				parentId: "rectA",
				node: createRect({ id: "x", bounds: { width: 1, height: 1 } }),
			});
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasIRMutationError);
			expect((err as CanvasIRMutationError).code).toBe("parent-not-group");
		}
	});

	it("throws index-out-of-range for negative/too-large indices", () => {
		const ir = sampleIR();
		expect(() =>
			insertNode(ir, {
				parentId: "outer",
				node: createRect({ id: "x", bounds: { width: 1, height: 1 } }),
				index: -1,
			}),
		).toThrow(CanvasIRMutationError);
	});
});

describe("removeNode", () => {
	it("removes a deep leaf and is pure", () => {
		const ir = sampleIR();
		const before = snapshot(ir);
		const after = removeNode(ir, { id: "text1", now: tick });
		expect(ir).toEqual(before);
		expect(findNode(after, "text1")).toBeNull();
		expect(findNode(after, "inner")?.node.id).toBe("inner");
	});

	it("removes an empty group", () => {
		const ir = sampleIR();
		const withEmpty = insertNode(ir, {
			parentId: "outer",
			node: createGroup({ id: "empty" }),
			now: tick,
		});
		const after = removeNode(withEmpty, { id: "empty", now: tick });
		expect(findNode(after, "empty")).toBeNull();
	});

	it("rejects removing a page-root group", () => {
		const ir = sampleIR();
		try {
			removeNode(ir, { id: "page-root" });
		} catch (err) {
			expect((err as CanvasIRMutationError).code).toBe(
				"cannot-remove-page-root",
			);
		}
	});

	it("throws node-not-found for unknown id", () => {
		const ir = sampleIR();
		expect(() => removeNode(ir, { id: "missing" })).toThrow(
			CanvasIRMutationError,
		);
	});
});

describe("updateNode", () => {
	it("patches a leaf without changing id/type", () => {
		const ir = sampleIR();
		const before = snapshot(ir);
		const after = updateNode<"rect">(ir, {
			id: "rectA",
			patch: { fill: "#abc", bounds: { width: 99, height: 99 } },
			now: tick,
		});
		expect(ir).toEqual(before);
		const updated = findNode(after, "rectA")?.node as CanvasRectNode;
		expect(updated.fill).toBe("#abc");
		expect(updated.bounds).toEqual({ width: 99, height: 99 });
		expect(updated.type).toBe("rect");
	});

	it("preserves type even if patch tries to override it at runtime", () => {
		const ir = sampleIR();
		// Force a runtime override (TS prevents this via Omit<..., "type">).
		const after = updateNode<"rect">(ir, {
			id: "rectA",
			patch: { fill: "#000" } as unknown as Partial<CanvasRectNode>,
		});
		const node = findNode(after, "rectA")?.node;
		expect(node?.type).toBe("rect");
	});

	it("bumps updatedAt", () => {
		const ir = sampleIR();
		const after = updateNode<"rect">(ir, {
			id: "rectA",
			patch: { fill: "#1" },
			now: () => "2099-01-01T00:00:00.000Z",
		});
		expect(after.metadata.updatedAt).toBe("2099-01-01T00:00:00.000Z");
		expect(after.metadata.createdAt).toBe(ir.metadata.createdAt);
	});

	it("throws node-not-found for unknown id", () => {
		const ir = sampleIR();
		expect(() => updateNode(ir, { id: "missing", patch: {} })).toThrow(
			CanvasIRMutationError,
		);
	});
});

describe("moveNode", () => {
	it("moves a leaf into a different group", () => {
		const ir = sampleIR();
		const before = snapshot(ir);
		const after = moveNode(ir, {
			id: "rectA",
			newParentId: "inner",
			now: tick,
		});
		expect(ir).toEqual(before);
		const inner = findNode(after, "inner");
		if (inner?.node.type === "group") {
			expect(inner.node.children.some((c) => c.id === "rectA")).toBe(true);
		}
		const outer = findNode(after, "outer");
		if (outer?.node.type === "group") {
			expect(outer.node.children.some((c) => c.id === "rectA")).toBe(false);
		}
	});

	it("rejects moving a node into its own descendant", () => {
		const ir = sampleIR();
		try {
			moveNode(ir, { id: "outer", newParentId: "inner" });
		} catch (err) {
			expect((err as CanvasIRMutationError).code).toBe("cycle-detected");
		}
	});

	it("rejects moving a page-root group", () => {
		const ir = sampleIR();
		try {
			moveNode(ir, { id: "page-root", newParentId: "outer" });
		} catch (err) {
			expect((err as CanvasIRMutationError).code).toBe("cannot-move-page-root");
		}
	});
});

describe("reorderChildren", () => {
	it("is a true no-op when from === to — same reference, no metadata bump (C-6)", () => {
		const ir = sampleIR();
		const after = reorderChildren(ir, {
			parentId: "outer",
			fromIndex: 1,
			toIndex: 1,
			now: () => "2099-01-01T00:00:00.000Z",
		});
		expect(after).toBe(ir);
		expect(after.metadata.updatedAt).toBe(ir.metadata.updatedAt);
	});

	it("still validates a from === to reorder against a nonexistent parent (C-6)", () => {
		const ir = sampleIR();
		expect(() =>
			reorderChildren(ir, {
				parentId: "nope",
				fromIndex: 5,
				toIndex: 5,
			}),
		).toThrow(CanvasIRMutationError);
	});

	it("still validates a from === to reorder against out-of-range indices (C-6)", () => {
		const ir = sampleIR();
		expect(() =>
			reorderChildren(ir, {
				parentId: "outer",
				fromIndex: 99,
				toIndex: 99,
			}),
		).toThrow(CanvasIRMutationError);
	});

	it("swaps two siblings", () => {
		const ir = sampleIR();
		const before = snapshot(ir);
		const after = reorderChildren(ir, {
			parentId: "outer",
			fromIndex: 0,
			toIndex: 2,
			now: tick,
		});
		expect(ir).toEqual(before);
		const outer = findNode(after, "outer");
		if (outer?.node.type === "group") {
			expect(outer.node.children.map((c) => c.id)).toEqual([
				"inner",
				"rectB",
				"rectA",
			]);
		}
	});

	it("throws index-out-of-range for invalid indices", () => {
		const ir = sampleIR();
		expect(() =>
			reorderChildren(ir, {
				parentId: "outer",
				fromIndex: 0,
				toIndex: 99,
			}),
		).toThrow(CanvasIRMutationError);
	});
});

describe("updatedAt cadence", () => {
	it("advances on each mutation; createdAt is preserved", () => {
		const ir = sampleIR();
		const initialCreated = ir.metadata.createdAt;
		const after1 = insertNode(ir, {
			parentId: "outer",
			node: createRect({ id: "x", bounds: { width: 1, height: 1 } }),
			now: () => "2026-06-01T00:00:00.000Z",
		});
		expect(after1.metadata.updatedAt).toBe("2026-06-01T00:00:00.000Z");
		expect(after1.metadata.createdAt).toBe(initialCreated);
		const after2 = removeNode(after1, {
			id: "x",
			now: () => "2026-07-01T00:00:00.000Z",
		});
		expect(after2.metadata.updatedAt).toBe("2026-07-01T00:00:00.000Z");
		expect(after2.metadata.createdAt).toBe(initialCreated);
	});
});

describe("replaceChildrenInParent", () => {
	it("rewrites a parent's children in one pass and is pure", () => {
		const ir = sampleIR();
		const before = snapshot(ir);
		const next = replaceChildrenInParent(ir, {
			parentId: "outer",
			replace: (children) => children.filter((c) => c.id !== "rectA"),
			now: tick,
		});
		expect(findNode(next, "rectA")).toBeNull();
		expect(findNode(next, "rectB")).not.toBeNull();
		expect(next.metadata.updatedAt).not.toBe(ir.metadata.updatedAt);
		// original untouched
		expect(snapshot(ir)).toEqual(before);
	});

	it("throws parent-not-found / parent-not-group", () => {
		const ir = sampleIR();
		expect(() =>
			replaceChildrenInParent(ir, {
				parentId: "missing",
				replace: (c) => [...c],
			}),
		).toThrow(CanvasIRMutationError);
		expect(() =>
			replaceChildrenInParent(ir, {
				parentId: "rectA",
				replace: (c) => [...c],
			}),
		).toThrow(/not a container/i);
	});
});

describe("mutation depth guard", () => {
	// Build a page whose root nests MAX_TREE_DEPTH+2 groups deep, with the leaf
	// group holding a sentinel child the mutation will try to reach.
	function deepIR(): CanvasIR {
		let node = createGroup({ id: "leaf", bounds: { width: 0, height: 0 } });
		for (let i = MAX_TREE_DEPTH + 1; i >= 0; i--) {
			node = createGroup({
				id: `g-${i}`,
				bounds: { width: 0, height: 0 },
				children: [node],
			});
		}
		const page = createPage({ id: "p-deep" });
		page.root = node;
		return createCanvasIR({ pages: [page] });
	}

	it("insertNode throws CanvasIRDepthError instead of overflowing the stack", () => {
		expect(() =>
			insertNode(deepIR(), {
				parentId: "leaf",
				node: createRect({ id: "x", bounds: { width: 1, height: 1 } }),
			}),
		).toThrow(CanvasIRDepthError);
	});

	it("updateNode throws CanvasIRDepthError on a too-deep tree", () => {
		expect(() =>
			updateNode(deepIR(), { id: "leaf", patch: { name: "renamed" } }),
		).toThrow(CanvasIRDepthError);
	});

	/** A chain of `count` nested groups, innermost holding no children (a leaf). */
	function nestedGroups(count: number, innermostId: string): CanvasGroupNode {
		let node: CanvasNode = createGroup({
			id: innermostId,
			bounds: { width: 0, height: 0 },
		});
		for (let i = count - 1; i >= 0; i--) {
			node = createGroup({
				id: `n-${i}`,
				bounds: { width: 0, height: 0 },
				children: [node],
			});
		}
		return node as CanvasGroupNode;
	}

	it("insertNode rejects a deep SUBTREE inserted at a moderately deep parent, even though the parent lookup itself is in-range (C-16)", () => {
		// Root nests 30 groups deep down to "parent" (well within MAX_TREE_DEPTH),
		// then insert a subtree that is itself 40 groups deep — combined depth
		// (30 + 1 + 40) exceeds MAX_TREE_DEPTH even though neither the parent
		// lookup nor the inserted subtree alone would trip the guard.
		const page = createPage({ id: "p-moderate" });
		page.root = nestedGroups(30, "parent");
		const ir = createCanvasIR({ pages: [page] });
		expect(() =>
			insertNode(ir, {
				parentId: "parent",
				node: nestedGroups(40, "deep-leaf"),
			}),
		).toThrow(CanvasIRDepthError);
	});

	it("insertNode accepts a subtree that keeps the combined depth within MAX_TREE_DEPTH", () => {
		const page = createPage({ id: "p-moderate" });
		page.root = nestedGroups(10, "parent");
		const ir = createCanvasIR({ pages: [page] });
		expect(() =>
			insertNode(ir, {
				parentId: "parent",
				node: nestedGroups(5, "shallow-leaf"),
			}),
		).not.toThrow();
	});
});

describe("updateNode undefined-key semantics (P3-1)", () => {
	it("patching an optional key to undefined deletes it (absent, not key:undefined)", () => {
		const ir = sampleIR();
		// rectA has fill: "#f00". Patch fill -> undefined should REMOVE the key.
		const after = updateNode<"rect">(ir, {
			id: "rectA",
			patch: { fill: undefined },
		});
		const node = findNode(after, "rectA")?.node as CanvasRectNode;
		expect("fill" in node).toBe(false);
	});
});
