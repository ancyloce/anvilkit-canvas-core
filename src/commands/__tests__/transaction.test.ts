import { describe, expect, it } from "vitest";
import { createCanvasIR, createPage, createRect } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../../ir/types.js";
import { findNode } from "../../ir/walkers.js";
import { applyCommand } from "../runtime.js";
import { applyCommands } from "../transaction.js";
import type { CanvasBatchCommand } from "../types.js";

function makeIR(): { ir: CanvasIR; rootId: string } {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	const rect = createRect({
		id: "r1",
		bounds: { width: 10, height: 10 },
		transform: { x: 0, y: 0 },
	});
	ir = insertNode(ir, { parentId: page.root.id, node: rect });
	return { ir, rootId: page.root.id };
}

function nodeOf(ir: CanvasIR, id: string): CanvasNode {
	const found = findNode(ir, id);
	if (!found) throw new Error(`node ${id} not found`);
	return found.node;
}

describe("applyCommands", () => {
	it("applies commands in order and round-trips via the composite inverse", () => {
		const { ir: ir0 } = makeIR();
		const { ir: ir1, inverse } = applyCommands(ir0, [
			{
				type: "node.move",
				nodeId: "r1",
				from: { x: 0, y: 0 },
				to: { x: 10, y: 0 },
			},
			{ type: "node.rotate", nodeId: "r1", from: 0, to: 45 },
		]);

		const n1 = nodeOf(ir1, "r1");
		expect(n1.transform.x).toBe(10);
		expect(n1.transform.rotation).toBe(45);

		expect(inverse.type).toBe("batch");
		const { ir: ir2 } = applyCommand(ir1, inverse);
		const n2 = nodeOf(ir2, "r1");
		expect(n2.transform.x).toBe(0);
		expect(n2.transform.rotation).toBe(0);
	});

	it("derives per-command change records in apply order", () => {
		const { ir: ir0 } = makeIR();
		const { changes } = applyCommands(ir0, [
			{
				type: "node.move",
				nodeId: "r1",
				from: { x: 0, y: 0 },
				to: { x: 10, y: 4 },
			},
			{ type: "node.rotate", nodeId: "r1", from: 0, to: 90 },
		]);
		expect(changes).toEqual([
			{ kind: "transform", nodeId: "r1", dx: 10, dy: 4, drot: 0 },
			{ kind: "transform", nodeId: "r1", dx: 0, dy: 0, drot: 90 },
		]);
	});

	it("derives enriched change records with resolved pageId and incrementing sequence", () => {
		const { ir: ir0 } = makeIR();
		const { records } = applyCommands(
			ir0,
			[
				{
					type: "node.move",
					nodeId: "r1",
					from: { x: 0, y: 0 },
					to: { x: 10, y: 4 },
				},
				{ type: "node.rotate", nodeId: "r1", from: 0, to: 90 },
			],
			{ actorId: "peer-1", source: "remote" },
		);
		expect(records).toHaveLength(2);
		expect(records[0]).toMatchObject({
			pageId: "p1",
			nodeIds: ["r1"],
			actorId: "peer-1",
			source: "remote",
			sequence: 0,
		});
		expect(records[1]).toMatchObject({
			pageId: "p1",
			nodeIds: ["r1"],
			actorId: "peer-1",
			source: "remote",
			sequence: 1,
		});
	});

	it("is all-or-nothing — a mid-batch failure leaves the input IR untouched", () => {
		const { ir: ir0 } = makeIR();
		expect(() =>
			applyCommands(ir0, [
				{
					type: "node.move",
					nodeId: "r1",
					from: { x: 0, y: 0 },
					to: { x: 99, y: 0 },
				},
				{
					type: "node.move",
					nodeId: "ghost",
					from: { x: 0, y: 0 },
					to: { x: 1, y: 1 },
				},
			]),
		).toThrow();
		// The good first move must NOT have leaked into ir0.
		expect(nodeOf(ir0, "r1").transform.x).toBe(0);
	});

	it("handles an empty batch as a no-op", () => {
		const { ir: ir0 } = makeIR();
		const { ir, inverse, changes, records } = applyCommands(ir0, []);
		expect(changes).toEqual([]);
		expect(records).toEqual([]);
		expect(inverse.commands).toEqual([]);
		expect(nodeOf(ir, "r1").transform.x).toBe(0);
	});

	it("supports nested batches and round-trips them", () => {
		const { ir: ir0 } = makeIR();
		const nested: CanvasBatchCommand = {
			type: "batch",
			commands: [
				{
					type: "node.move",
					nodeId: "r1",
					from: { x: 0, y: 0 },
					to: { x: 5, y: 5 },
				},
				{
					type: "batch",
					commands: [{ type: "node.rotate", nodeId: "r1", from: 0, to: 90 }],
				},
			],
		};
		const { ir: ir1, inverse } = applyCommand(ir0, nested);
		expect(nodeOf(ir1, "r1").transform.x).toBe(5);
		expect(nodeOf(ir1, "r1").transform.rotation).toBe(90);

		const { ir: ir2 } = applyCommand(ir1, inverse);
		expect(nodeOf(ir2, "r1").transform.x).toBe(0);
		expect(nodeOf(ir2, "r1").transform.rotation).toBe(0);
	});
});
