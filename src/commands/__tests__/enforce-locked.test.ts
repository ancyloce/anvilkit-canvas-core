import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
} from "../../ir/builders.js";
import type { CanvasIR } from "../../ir/types.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";
import type { CanvasCommand } from "../types.js";

/**
 * root
 * ├─ a (rect, unlocked)
 * ├─ locked1 (rect, LOCKED)
 * ├─ lg (group, LOCKED) ── b (rect)
 * └─ g (group) ── lc (rect, LOCKED)
 */
function makeIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "root",
		bounds: page.root.bounds,
		children: [
			createRect({ id: "a", bounds: { width: 1, height: 1 } }),
			{
				...createRect({ id: "locked1", bounds: { width: 1, height: 1 } }),
				locked: true,
			},
			{
				...createGroup({
					id: "lg",
					children: [createRect({ id: "b", bounds: { width: 1, height: 1 } })],
				}),
				locked: true,
			},
			createGroup({
				id: "g",
				children: [
					{
						...createRect({ id: "lc", bounds: { width: 1, height: 1 } }),
						locked: true,
					},
				],
			}),
		],
	});
	return createCanvasIR({ id: "ir", pages: [page], now: () => "T" });
}

function lockedCode(cmd: CanvasCommand): string | null {
	try {
		applyCommand(makeIR(), cmd, { enforceLocked: true });
		return null;
	} catch (err) {
		return err instanceof CanvasCommandError ? err.code : "unexpected-type";
	}
}

const MOVE_LOCKED: CanvasCommand = {
	type: "node.move",
	nodeId: "locked1",
	from: { x: 0, y: 0 },
	to: { x: 5, y: 5 },
};

describe("enforceLocked (A-02)", () => {
	it("is OFF by default — locked nodes stay mutable for existing consumers", () => {
		const { ir } = applyCommand(makeIR(), MOVE_LOCKED);
		expect(ir).toBeTruthy();
		const { ir: deleted } = applyCommand(makeIR(), {
			type: "node.delete",
			nodeId: "locked1",
		});
		expect(deleted).toBeTruthy();
	});

	it("rejects every mutating command against a locked node", () => {
		expect(lockedCode(MOVE_LOCKED)).toBe("node-locked");
		expect(lockedCode({ type: "node.delete", nodeId: "locked1" })).toBe(
			"node-locked",
		);
		expect(
			lockedCode({
				type: "node.resize",
				nodeId: "locked1",
				from: { x: 0, y: 0, width: 1, height: 1 },
				to: { x: 0, y: 0, width: 9, height: 9 },
			}),
		).toBe("node-locked");
		expect(
			lockedCode({ type: "node.rotate", nodeId: "locked1", from: 0, to: 45 }),
		).toBe("node-locked");
		expect(
			lockedCode({
				type: "node.update",
				nodeId: "locked1",
				kind: "rect",
				patch: { name: "renamed" },
			}),
		).toBe("node-locked");
		expect(
			lockedCode({ type: "node.reorder", nodeId: "locked1", toIndex: 0 }),
		).toBe("node-locked");
		expect(
			lockedCode({
				type: "node.reparent",
				nodeId: "locked1",
				toParentId: "g",
				toIndex: 0,
			}),
		).toBe("node-locked");
		expect(lockedCode({ type: "node.ungroup", groupId: "lg" })).toBe(
			"node-locked",
		);
		expect(
			lockedCode({
				type: "node.group",
				pageId: "p1",
				childIds: ["lc"],
				groupId: "ng",
			}),
		).toBe("node-locked");
	});

	it("still applies commands against unlocked nodes when enforcing", () => {
		const { ir } = applyCommand(
			makeIR(),
			{
				type: "node.move",
				nodeId: "a",
				from: { x: 0, y: 0 },
				to: { x: 3, y: 3 },
			},
			{ enforceLocked: true },
		);
		expect(ir).toBeTruthy();
	});

	it("exempts lock-state patches so a locked node can be unlocked", () => {
		const { ir } = applyCommand(
			makeIR(),
			{
				type: "node.update",
				nodeId: "locked1",
				kind: "rect",
				patch: { locked: false, name: "unlocked-now" },
			},
			{ enforceLocked: true },
		);
		const page = ir.pages[0];
		const node = page?.root.children.find((c) => c.id === "locked1");
		expect(node?.locked).toBe(false);
		expect(node?.name).toBe("unlocked-now");
	});

	it("propagates through a batch and stays all-or-nothing", () => {
		const ir0 = makeIR();
		const before = JSON.stringify(ir0);
		let code: string | null = null;
		try {
			applyCommand(
				ir0,
				{
					type: "batch",
					commands: [
						{
							type: "node.move",
							nodeId: "a",
							from: { x: 0, y: 0 },
							to: { x: 3, y: 3 },
						},
						{ type: "node.delete", nodeId: "locked1" },
					],
				},
				{ enforceLocked: true },
			);
		} catch (err) {
			code = err instanceof CanvasCommandError ? err.code : "unexpected-type";
		}
		expect(code).toBe("node-locked");
		// applyCommand is pure — the input document is untouched by the failure.
		expect(JSON.stringify(ir0)).toBe(before);
	});
});
