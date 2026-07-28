import { describe, expect, it } from "vitest";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasAutoLayout, CanvasIR, CanvasNode } from "../../ir/types.js";
import { findNode, parentOf } from "../../ir/walkers.js";
import { MAX_COMPOSITE_COMMAND_DESCENDANTS } from "../../limits.js";
import { commandToChange } from "../change-events.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";
import type {
	CanvasFrameRemoveLayoutCommand,
	CanvasFrameSetLayoutCommand,
	CanvasSelectionWrapInLayoutFrameCommand,
} from "../types.js";

/**
 * @file T-M1-08 — the three layout commands (TS-21 round-trip, TS-22
 * atomicity, TS-25 lock scoping, TS-26 change-record lossiness).
 */

const box = { width: 40, height: 40 };

const layout: CanvasAutoLayout = {
	version: 1,
	direction: "horizontal",
	padding: { top: 4, right: 4, bottom: 4, left: 4 },
	gap: 8,
	primaryAlign: "start",
	crossAlign: "center",
};

const otherLayout: CanvasAutoLayout = {
	...layout,
	direction: "vertical",
	gap: 16,
};

const identity = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };

/** A page whose root holds `ids` as rects, plus an empty frame `f1`. */
function docWithFrame(): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createFrame({ id: "f1", bounds: box }),
	});
	ir = insertNode(ir, {
		parentId: "f1",
		node: createRect({ id: "c1", bounds: box }),
	});
	ir = insertNode(ir, {
		parentId: "f1",
		node: createRect({ id: "c2", bounds: box }),
	});
	return ir;
}

/** A page root holding rects with the given ids, in order. */
function docWithRects(ids: readonly string[]): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	for (const id of ids) {
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createRect({ id, bounds: box }),
		});
	}
	return ir;
}

/** Fixture accessor that fails loudly instead of optional-chaining into undefined. */
function nodeOf(ir: CanvasIR, id: string): CanvasNode {
	const found = findNode(ir, id);
	if (!found) throw new Error(`fixture: node "${id}" not found`);
	return found.node;
}

const frameOf = (ir: CanvasIR, id = "f1") =>
	nodeOf(ir, id) as Extract<CanvasNode, { type: "frame" }>;

const childIdsOf = (ir: CanvasIR, parentId: string) =>
	(nodeOf(ir, parentId) as { children: CanvasNode[] }).children.map(
		(c) => c.id,
	);

/** Strip the mutable `metadata.updatedAt` so round-trips compare structurally. */
const stable = (ir: CanvasIR) => ({
	...ir,
	metadata: { ...ir.metadata, updatedAt: "FIXED" },
});

describe("frame.set-layout", () => {
	it("writes the intent and inverts back to no layout (TS-21)", () => {
		const ir = docWithFrame();
		const cmd: CanvasFrameSetLayoutCommand = {
			type: "frame.set-layout",
			nodeId: "f1",
			layout,
		};
		const { ir: next, inverse } = applyCommand(ir, cmd);
		expect(frameOf(next).autoLayout).toEqual(layout);
		expect(inverse).toEqual({ type: "frame.remove-layout", nodeId: "f1" });

		const back = applyCommand(next, inverse).ir;
		expect(frameOf(back).autoLayout).toBeUndefined();
		// The key must be GONE, not present-and-undefined.
		expect("autoLayout" in frameOf(back)).toBe(false);
		expect(stable(back)).toEqual(stable(ir));
	});

	it("replaces an existing intent and inverts to the exact prior one", () => {
		const withLayout = applyCommand(docWithFrame(), {
			type: "frame.set-layout",
			nodeId: "f1",
			layout,
		}).ir;
		const { ir: next, inverse } = applyCommand(withLayout, {
			type: "frame.set-layout",
			nodeId: "f1",
			layout: otherLayout,
		});
		expect(frameOf(next).autoLayout).toEqual(otherLayout);
		expect(inverse).toEqual({
			type: "frame.set-layout",
			nodeId: "f1",
			layout,
		});
		expect(frameOf(applyCommand(next, inverse).ir).autoLayout).toEqual(layout);
	});

	it("carries caller-computed geometry and restores it exactly", () => {
		const ir = docWithFrame();
		const cmd: CanvasFrameSetLayoutCommand = {
			type: "frame.set-layout",
			nodeId: "f1",
			layout,
			geometry: [
				{
					nodeId: "c1",
					transform: { ...identity, x: 4 },
					bounds: { width: 10, height: 10 },
					layoutItem: { widthSizing: "fill" },
				},
			],
		};
		const { ir: next, inverse } = applyCommand(ir, cmd);
		const c1 = nodeOf(next, "c1") as CanvasNode;
		expect(c1.transform.x).toBe(4);
		expect(c1.bounds).toEqual({ width: 10, height: 10 });
		expect(c1.layoutItem).toEqual({ widthSizing: "fill" });

		const back = applyCommand(next, inverse).ir;
		expect(stable(back)).toEqual(stable(ir));
		// `layoutItem` was absent before, so the restore must DELETE it.
		expect("layoutItem" in (nodeOf(back, "c1") as object)).toBe(false);
	});

	it("rejects a non-frame node with kind-mismatch", () => {
		const ir = docWithFrame();
		try {
			applyCommand(ir, {
				type: "frame.set-layout",
				nodeId: "c1",
				layout,
			});
			expect.unreachable("must throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasCommandError);
			expect((err as CanvasCommandError).code).toBe("kind-mismatch");
		}
	});

	it("rejects a missing node with node-not-found", () => {
		try {
			applyCommand(docWithFrame(), {
				type: "frame.set-layout",
				nodeId: "nope",
				layout,
			});
			expect.unreachable("must throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("node-not-found");
		}
	});
});

describe("frame.remove-layout", () => {
	it("bakes resolved geometry in and inverts to intent + prior geometry", () => {
		const base = applyCommand(docWithFrame(), {
			type: "frame.set-layout",
			nodeId: "f1",
			layout,
			geometry: [{ nodeId: "c1", layoutItem: { widthSizing: "fill" } }],
		}).ir;

		const cmd: CanvasFrameRemoveLayoutCommand = {
			type: "frame.remove-layout",
			nodeId: "f1",
			geometry: [
				{
					nodeId: "c1",
					transform: { ...identity, x: 12 },
					bounds: { width: 20, height: 30 },
					layoutItem: null,
				},
			],
		};
		const { ir: next, inverse } = applyCommand(base, cmd);
		expect(frameOf(next).autoLayout).toBeUndefined();
		const c1 = nodeOf(next, "c1") as CanvasNode;
		expect(c1.transform.x).toBe(12);
		expect(c1.bounds).toEqual({ width: 20, height: 30 });
		expect("layoutItem" in (c1 as object)).toBe(false);

		expect(inverse.type).toBe("frame.set-layout");
		const back = applyCommand(next, inverse).ir;
		expect(stable(back)).toEqual(stable(base));
		expect(frameOf(back).autoLayout).toEqual(layout);
		expect((nodeOf(back, "c1") as CanvasNode).layoutItem).toEqual({
			widthSizing: "fill",
		});
	});

	it("is a no-op-safe inverse when the frame had no layout", () => {
		const ir = docWithFrame();
		const { ir: next, inverse } = applyCommand(ir, {
			type: "frame.remove-layout",
			nodeId: "f1",
		});
		expect(inverse).toEqual({ type: "frame.remove-layout", nodeId: "f1" });
		expect(stable(applyCommand(next, inverse).ir)).toEqual(stable(ir));
	});
});

describe("selection.wrap-in-layout-frame", () => {
	const wrap = (
		childIds: string[],
		extra?: Partial<CanvasSelectionWrapInLayoutFrameCommand>,
	): CanvasSelectionWrapInLayoutFrameCommand => ({
		type: "selection.wrap-in-layout-frame",
		pageId: "p1",
		childIds,
		frameId: "wrapped",
		transform: identity,
		bounds: { width: 100, height: 50 },
		layout,
		...extra,
	});

	it("wraps a contiguous selection at the topmost slot and inverts exactly", () => {
		const ir = docWithRects(["a", "b", "c", "d"]);
		const rootId = ir.pages[0]?.root.id as string;
		const { ir: next, inverse } = applyCommand(ir, wrap(["b", "c"]));

		expect(childIdsOf(next, rootId)).toEqual(["a", "wrapped", "d"]);
		expect(childIdsOf(next, "wrapped")).toEqual(["b", "c"]);
		expect(frameOf(next, "wrapped").autoLayout).toEqual(layout);

		const back = applyCommand(next, inverse).ir;
		expect(childIdsOf(back, rootId)).toEqual(["a", "b", "c", "d"]);
		expect(findNode(back, "wrapped")).toBeNull();
	});

	it("restores the exact permutation for a NON-contiguous selection", () => {
		// The case a plain reparent-back cannot handle: reinserting at recorded
		// indices while the frame still occupies a slot yields the wrong order,
		// which is why the inverse also carries a reorder pass.
		const ir = docWithRects(["a", "b", "c", "d"]);
		const rootId = ir.pages[0]?.root.id as string;
		const { ir: next, inverse } = applyCommand(ir, wrap(["a", "c"]));
		expect(childIdsOf(next, rootId)).toEqual(["wrapped", "b", "d"]);

		const back = applyCommand(next, inverse).ir;
		expect(childIdsOf(back, rootId)).toEqual(["a", "b", "c", "d"]);
	});

	it("restores child geometry the wrap rewrote", () => {
		const ir = docWithRects(["a", "b"]);
		const { ir: next, inverse } = applyCommand(
			ir,
			wrap(["a", "b"], {
				geometry: [
					{
						nodeId: "a",
						transform: { ...identity, x: 4 },
						layoutItem: { widthSizing: "fill" },
					},
				],
			}),
		);
		expect((nodeOf(next, "a") as CanvasNode).transform.x).toBe(4);

		const back = applyCommand(next, inverse).ir;
		expect(stable(back)).toEqual(stable(ir));
		expect("layoutItem" in (nodeOf(back, "a") as object)).toBe(false);
	});

	it("rejects a cross-parent selection (TS-22 — original IR returned)", () => {
		// `nested` lives inside the frame, `c1`'s sibling `f1` lives at the root.
		const ir = docWithFrame();
		const before = stable(ir);
		expect(() =>
			applyCommand(ir, wrap(["f1", "c1"])),
		).toThrow(/same parent/);
		// TS-22: a rejected composite leaves the ORIGINAL document untouched.
		expect(stable(ir)).toEqual(before);
	});

	it("rejects an already-taken frame id", () => {
		try {
			applyCommand(docWithRects(["a", "b"]), wrap(["a"], { frameId: "b" }));
			expect.unreachable("must throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
		}
	});

	it("rejects duplicate and empty childIds", () => {
		const ir = docWithRects(["a", "b"]);
		expect(() => applyCommand(ir, wrap(["a", "a"]))).toThrow(/duplicates/);
		expect(() => applyCommand(ir, wrap([]))).toThrow(/at least one/);
	});
});

describe("lock scoping (TS-25)", () => {
	const opts = { enforceLocked: true } as const;

	it("rejects a command targeting the locked node itself", () => {
		let ir = docWithFrame();
		ir = applyCommand(ir, {
			type: "node.update",
			nodeId: "f1",
			kind: "frame",
			patch: { locked: true },
		} as never).ir;
		try {
			applyCommand(
				ir,
				{ type: "frame.set-layout", nodeId: "f1", layout },
				opts,
			);
			expect.unreachable("must throw");
		} catch (err) {
			expect((err as CanvasCommandError).code).toBe("node-locked");
		}
	});

	it("rejects a geometry write that would move a locked node", () => {
		let ir = docWithFrame();
		ir = applyCommand(ir, {
			type: "node.update",
			nodeId: "c1",
			kind: "rect",
			patch: { locked: true },
		} as never).ir;
		expect(() =>
			applyCommand(
				ir,
				{
					type: "frame.remove-layout",
					nodeId: "f1",
					geometry: [{ nodeId: "c1", transform: { ...identity, x: 9 } }],
				},
				opts,
			),
		).toThrow(/locked/);
	});

	it("does NOT reject merely because a locked SIBLING's index shifts", () => {
		// Locking protects a node's own properties and position, not its
		// neighbours' indices — otherwise one locked child could freeze a whole
		// container, which no author expects from a lock icon.
		let ir = docWithRects(["a", "b", "c"]);
		ir = applyCommand(ir, {
			type: "node.update",
			nodeId: "c",
			kind: "rect",
			patch: { locked: true },
		} as never).ir;
		expect(() =>
			applyCommand(
				ir,
				{
					type: "selection.wrap-in-layout-frame",
					pageId: "p1",
					childIds: ["a", "b"],
					frameId: "wrapped",
					transform: identity,
					bounds: box,
					layout,
				},
				opts,
			),
		).not.toThrow();
	});
});

describe("change mapping (TS-26)", () => {
	it("maps layout intent writes onto the existing `updated` kind", () => {
		expect(
			commandToChange({ type: "frame.set-layout", nodeId: "f1", layout }),
		).toEqual({ kind: "updated", nodeId: "f1", keys: ["autoLayout"] });
		expect(
			commandToChange({ type: "frame.remove-layout", nodeId: "f1" }),
		).toEqual({ kind: "updated", nodeId: "f1", keys: ["autoLayout"] });
	});

	it("maps the wrap onto `added`, mirroring node.group", () => {
		expect(
			commandToChange({
				type: "selection.wrap-in-layout-frame",
				pageId: "p1",
				childIds: ["a"],
				frameId: "wrapped",
				transform: identity,
				bounds: box,
				layout,
			}),
		).toEqual({ kind: "added", nodeId: "wrapped", pageId: "p1" });
	});

	it("the derived record is lossy, but replaying the COMMAND is not", () => {
		const ir = docWithRects(["a", "b", "c"]);
		const rootId = ir.pages[0]?.root.id as string;
		const cmd: CanvasSelectionWrapInLayoutFrameCommand = {
			type: "selection.wrap-in-layout-frame",
			pageId: "p1",
			childIds: ["a", "b"],
			frameId: "wrapped",
			transform: identity,
			bounds: box,
			layout,
		};
		// The derived change names only the added frame — not the 2 reparents.
		expect(commandToChange(cmd)).toEqual({
			kind: "added",
			nodeId: "wrapped",
			pageId: "p1",
		});
		// Replaying the command itself reproduces the full effect.
		const replayed = applyCommand(ir, cmd).ir;
		expect(childIdsOf(replayed, rootId)).toEqual(["wrapped", "c"]);
		expect(childIdsOf(replayed, "wrapped")).toEqual(["a", "b"]);
	});
});

describe("registry parity — the three commands are un-shadowable built-ins", () => {
	it.each([
		"frame.set-layout",
		"frame.remove-layout",
		"selection.wrap-in-layout-frame",
	])("refuses to let an extension shadow %s", (type) => {
		// The M0 registry-parity fix in action: because all three types are in
		// BUILTIN_COMMAND_TYPE_FLAGS, an extension cannot even REGISTER a
		// handler for them — a stronger guarantee than merely routing to core.
		expect(() =>
			createCanvasRuntime([
				{
					id: "shadow-attempt",
					commands: [
						{
							type,
							apply: () => {
								throw new Error("extension handler must never run");
							},
						} as never,
					],
				},
			]),
		).toThrow(/built-in command types cannot be shadowed/);
	});

	it("round-trips all three through createCanvasRuntime().apply", () => {
		const runtime = createCanvasRuntime();
		const ir = docWithRects(["a", "b"]);

		const wrapped = runtime.apply(ir, {
			type: "selection.wrap-in-layout-frame",
			pageId: "p1",
			childIds: ["a", "b"],
			frameId: "wrapped",
			transform: identity,
			bounds: box,
			layout,
		});
		expect(findNode(wrapped.ir, "wrapped")).toBeDefined();

		const set = runtime.apply(wrapped.ir, {
			type: "frame.set-layout",
			nodeId: "wrapped",
			layout: otherLayout,
		});
		const removed = runtime.apply(set.ir, {
			type: "frame.remove-layout",
			nodeId: "wrapped",
		});
		expect(frameOf(removed.ir, "wrapped").autoLayout).toBeUndefined();

		// Unwind the whole chain.
		let back = runtime.apply(removed.ir, removed.inverse).ir;
		back = runtime.apply(back, set.inverse).ir;
		back = runtime.apply(back, wrapped.inverse).ir;
		expect(parentOf(back, "a")?.parent.id).toBe(ir.pages[0]?.root.id);
		expect(findNode(back, "wrapped")).toBeNull();
	});
});

describe("composite payload descendant ceiling (TS-24, T-M1-09)", () => {
	/** A frame holding `count` rect children, built literally (fast, no O(n) commands). */
	function frameWithChildren(count: number): CanvasIR {
		const page = createPage({ id: "p1" });
		const base = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		const children = Array.from({ length: count }, (_, i) => ({
			...createRect({ id: `k${i}`, bounds: box }),
		}));
		const frame = {
			...createFrame({ id: "big", bounds: box }),
			children,
		} as CanvasNode;
		return {
			...base,
			pages: [
				{
					...page,
					root: { ...page.root, children: [frame] },
				},
			],
		};
	}

	it("accepts a payload exactly at the ceiling", () => {
		const ir = frameWithChildren(MAX_COMPOSITE_COMMAND_DESCENDANTS);
		expect(() =>
			applyCommand(ir, { type: "frame.remove-layout", nodeId: "big" }),
		).not.toThrow();
	});

	it("rejects frame.remove-layout one node past the ceiling", () => {
		const ir = frameWithChildren(MAX_COMPOSITE_COMMAND_DESCENDANTS + 1);
		try {
			applyCommand(ir, { type: "frame.remove-layout", nodeId: "big" });
			expect.unreachable("must throw");
		} catch (err) {
			expect(err).toBeInstanceOf(CanvasCommandError);
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
			expect((err as CanvasCommandError).message).toContain(
				"MAX_COMPOSITE_COMMAND_DESCENDANTS",
			);
		}
	});

	it("rejects an over-limit geometry payload — never a silent large allocation", () => {
		const ir = docWithFrame();
		const geometry = Array.from(
			{ length: MAX_COMPOSITE_COMMAND_DESCENDANTS + 1 },
			(_, i) => ({ nodeId: `ghost-${i}` }),
		);
		try {
			applyCommand(ir, {
				type: "frame.remove-layout",
				nodeId: "f1",
				geometry,
			});
			expect.unreachable("must throw");
		} catch (err) {
			// Crucially it is the CEILING that rejects, not `node-not-found` on the
			// first bogus id — the guard runs before any per-node work.
			expect((err as CanvasCommandError).code).toBe("invariant-violated");
			expect((err as CanvasCommandError).message).toContain("geometry writes");
		}
	});

	it("rejects selection.wrap-in-layout-frame past the ceiling", () => {
		const page = createPage({ id: "p1" });
		const base = createCanvasIR({ id: "doc", title: "t", pages: [page] });
		const kids = Array.from({ length: MAX_COMPOSITE_COMMAND_DESCENDANTS + 1 }, (_, i) =>
			createRect({ id: `w${i}`, bounds: box }),
		);
		const ir: CanvasIR = {
			...base,
			pages: [{ ...page, root: { ...page.root, children: kids } }],
		};
		expect(() =>
			applyCommand(ir, {
				type: "selection.wrap-in-layout-frame",
				pageId: "p1",
				childIds: kids.map((k) => k.id),
				frameId: "wrapped",
				transform: identity,
				bounds: box,
				layout,
			}),
		).toThrow(/MAX_COMPOSITE_COMMAND_DESCENDANTS/);
	});
});
