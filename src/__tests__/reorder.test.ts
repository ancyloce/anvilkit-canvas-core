import { describe, expect, it } from "vitest";
import { applyCommand } from "../commands/runtime.js";
import {
	createCanvasIR,
	createGroup,
	createPage,
	createRect,
} from "../ir/builders.js";
import type { CanvasIR } from "../ir/types.js";

function makeIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "root",
		bounds: page.root.bounds,
		children: [
			createRect({ id: "a", bounds: { width: 1, height: 1 } }),
			createRect({ id: "b", bounds: { width: 1, height: 1 } }),
			createRect({ id: "c", bounds: { width: 1, height: 1 } }),
		],
	});
	return createCanvasIR({ id: "ir", pages: [page], now: () => "T" });
}

function order(ir: CanvasIR): string[] {
	const page = ir.pages[0];
	if (!page) throw new Error("no page");
	return page.root.children.map((c) => c.id);
}

describe("node.reorder command", () => {
	it("moves a node to a new index and the inverse restores order", () => {
		const ir0 = makeIR();
		const { ir: ir1, inverse } = applyCommand(ir0, {
			type: "node.reorder",
			nodeId: "a",
			toIndex: 2,
		});
		expect(order(ir1)).toEqual(["b", "c", "a"]);
		expect(inverse).toMatchObject({
			type: "node.reorder",
			nodeId: "a",
			toIndex: 0,
		});
		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(order(ir2)).toEqual(["a", "b", "c"]);
	});

	it("clamps toIndex to the sibling range", () => {
		const { ir } = applyCommand(makeIR(), {
			type: "node.reorder",
			nodeId: "a",
			toIndex: 99,
		});
		expect(order(ir)).toEqual(["b", "c", "a"]);
	});
});
