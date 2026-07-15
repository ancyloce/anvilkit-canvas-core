import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createPage,
	createRect,
} from "../../ir/builders.js";
import type { CanvasIR } from "../../ir/types.js";
import { walkPage } from "../../ir/walkers.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";
import type { CanvasNodeReparentCommand } from "../types.js";

/**
 * root
 * ├─ a (rect)
 * ├─ g1 (group) ── b (rect)
 * └─ f1 (frame) ── c (rect)
 */
function makeIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "root",
		bounds: page.root.bounds,
		children: [
			createRect({ id: "a", bounds: { width: 1, height: 1 } }),
			createGroup({
				id: "g1",
				children: [createRect({ id: "b", bounds: { width: 1, height: 1 } })],
			}),
			createFrame({
				id: "f1",
				bounds: { width: 10, height: 10 },
				children: [createRect({ id: "c", bounds: { width: 1, height: 1 } })],
			}),
		],
	});
	return createCanvasIR({ id: "ir", pages: [page], now: () => "T" });
}

/** root ── outer (group) ── inner (group) ── leaf (rect) */
function makeNestedIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "root",
		bounds: page.root.bounds,
		children: [
			createGroup({
				id: "outer",
				children: [
					createGroup({
						id: "inner",
						children: [
							createRect({ id: "leaf", bounds: { width: 1, height: 1 } }),
						],
					}),
				],
			}),
		],
	});
	return createCanvasIR({ id: "ir", pages: [page], now: () => "T" });
}

function childIds(ir: CanvasIR, containerId: string): string[] {
	const page = ir.pages[0];
	if (!page) throw new Error("no page");
	let out: string[] | null = null;
	walkPage(page, ({ node }) => {
		if (node.id === containerId && "children" in node) {
			out = (node as { children: readonly { id: string }[] }).children.map(
				(c) => c.id,
			);
		}
	});
	if (!out) throw new Error(`container ${containerId} not found`);
	return out;
}

function reparent(
	nodeId: string,
	toParentId: string,
	toIndex: number,
): CanvasNodeReparentCommand {
	return { type: "node.reparent", nodeId, toParentId, toIndex };
}

/** Runs `fn`; returns the CanvasCommandError code, or null when nothing threw. */
function errorCode(fn: () => unknown): string | null {
	try {
		fn();
		return null;
	} catch (err) {
		return err instanceof CanvasCommandError ? err.code : "unexpected-type";
	}
}

describe("node.reparent command", () => {
	it("moves a node into a group; the inverse restores parent AND index", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, reparent("a", "g1", 0));
		expect(childIds(ir1, "root")).toEqual(["g1", "f1"]);
		expect(childIds(ir1, "g1")).toEqual(["a", "b"]);
		expect(inverse).toMatchObject({
			type: "node.reparent",
			nodeId: "a",
			toParentId: "root",
			toIndex: 0,
		});
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(childIds(ir2, "root")).toEqual(["a", "g1", "f1"]);
		expect(childIds(ir2, "g1")).toEqual(["b"]);
	});

	it("moves into a frame and out again via the inverse", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, reparent("b", "f1", 1));
		expect(childIds(ir1, "g1")).toEqual([]);
		expect(childIds(ir1, "f1")).toEqual(["c", "b"]);
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(childIds(ir2, "g1")).toEqual(["b"]);
		expect(childIds(ir2, "f1")).toEqual(["c"]);
	});

	it("same-parent reparent behaves like a reorder (remove-then-insert)", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, reparent("a", "root", 2));
		expect(childIds(ir1, "root")).toEqual(["g1", "f1", "a"]);
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(childIds(ir2, "root")).toEqual(["a", "g1", "f1"]);
	});

	it("clamps an out-of-range toIndex to a valid insert", () => {
		const ir0 = makeIR();
		const { ir: ir1 } = applyCommand(ir0, reparent("a", "g1", 999));
		expect(childIds(ir1, "g1")).toEqual(["b", "a"]);
		const { ir: ir2 } = applyCommand(ir1, reparent("a", "root", -5));
		expect(childIds(ir2, "root")[0]).toBe("a");
	});

	it("rejects a move into the node's own descendant (invariant-violated)", () => {
		const ir0 = makeNestedIR();
		expect(
			errorCode(() => applyCommand(ir0, reparent("outer", "inner", 0))),
		).toBe("invariant-violated");
		// The tree is untouched after the rejection.
		expect(childIds(ir0, "outer")).toEqual(["inner"]);
	});

	it("rejects page-root reparenting (parent-not-found)", () => {
		expect(
			errorCode(() => applyCommand(makeIR(), reparent("root", "f1", 0))),
		).toBe("parent-not-found");
	});

	it("rejects unknown and non-container targets", () => {
		expect(
			errorCode(() => applyCommand(makeIR(), reparent("a", "nope", 0))),
		).toBe("parent-not-found");
		expect(errorCode(() => applyCommand(makeIR(), reparent("a", "b", 0)))).toBe(
			"parent-not-group",
		);
	});

	it("participates in a batch with a correct composite inverse", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, {
			type: "batch",
			commands: [reparent("a", "g1", 0), reparent("c", "root", 0)],
		});
		expect(childIds(ir1, "g1")).toEqual(["a", "b"]);
		expect(childIds(ir1, "root")).toEqual(["c", "g1", "f1"]);
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(childIds(ir2, "root")).toEqual(["a", "g1", "f1"]);
		expect(childIds(ir2, "f1")).toEqual(["c"]);
	});

	it("property: apply + inverse always restores the exact page tree", () => {
		const leaves = ["a", "b", "c"] as const;
		const containers = ["root", "g1", "f1"] as const;
		fc.assert(
			fc.property(
				fc.constantFrom(...leaves),
				fc.constantFrom(...containers),
				fc.integer({ min: -2, max: 6 }),
				(nodeId, toParentId, toIndex) => {
					const ir0 = makeIR();
					const before = JSON.stringify(ir0.pages);
					const { ir: ir1, inverse } = applyCommand(
						ir0,
						reparent(nodeId, toParentId, toIndex),
					);
					const { ir: ir2 } = applyCommand(ir1, inverse);
					expect(JSON.stringify(ir2.pages)).toBe(before);
				},
			),
		);
	});
});
