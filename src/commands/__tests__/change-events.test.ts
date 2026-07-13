import { describe, expect, it } from "vitest";
import { createCanvasIR, createPage, createRect } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR } from "../../ir/types.js";
import { findNode } from "../../ir/walkers.js";
import {
	type CanvasChange,
	commandToChange,
	commandToChangeRecord,
	createChangeEmitter,
	replayChanges,
} from "../change-events.js";
import { applyCommand } from "../runtime.js";

function makeIR(): { ir: CanvasIR; pageId: string } {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	const rect = createRect({
		id: "r1",
		bounds: { width: 10, height: 10 },
		transform: { x: 0, y: 0 },
	});
	ir = insertNode(ir, { parentId: page.root.id, node: rect });
	return { ir, pageId: page.id };
}

describe("commandToChange", () => {
	it("maps node.move to a transform delta", () => {
		expect(
			commandToChange({
				type: "node.move",
				nodeId: "n1",
				from: { x: 5, y: 5 },
				to: { x: 15, y: 12 },
			}),
		).toEqual({ kind: "transform", nodeId: "n1", dx: 10, dy: 7, drot: 0 });
	});

	it("maps node.rotate to a rotation delta", () => {
		expect(
			commandToChange({ type: "node.rotate", nodeId: "n1", from: 0, to: 30 }),
		).toEqual({ kind: "transform", nodeId: "n1", dx: 0, dy: 0, drot: 30 });
	});

	it("maps node.resize to an updated record", () => {
		expect(
			commandToChange({
				type: "node.resize",
				nodeId: "n1",
				from: { x: 0, y: 0, width: 10, height: 10 },
				to: { x: 0, y: 0, width: 20, height: 20 },
			}),
		).toEqual({
			kind: "updated",
			nodeId: "n1",
			keys: ["transform", "bounds"],
		});
	});

	it("maps node.update to the patched keys", () => {
		expect(
			commandToChange({
				type: "node.update",
				nodeId: "n1",
				kind: "rect",
				patch: { fill: "#fff", radius: 4 },
			}),
		).toEqual({ kind: "updated", nodeId: "n1", keys: ["fill", "radius"] });
	});

	it("maps image.replace to an assetId update", () => {
		expect(
			commandToChange({
				type: "image.replace",
				nodeId: "img1",
				fromAssetId: "a",
				toAssetId: "b",
			}),
		).toEqual({ kind: "updated", nodeId: "img1", keys: ["assetId"] });
	});

	it("maps node.create to added (with pageId) and node.delete to removed", () => {
		const node = createRect({ bounds: { width: 1, height: 1 } });
		expect(
			commandToChange({ type: "node.create", node, pageId: "p1" }),
		).toEqual({ kind: "added", nodeId: node.id, pageId: "p1" });
		expect(commandToChange({ type: "node.delete", nodeId: node.id })).toEqual({
			kind: "removed",
			nodeId: node.id,
		});
	});

	it("maps group to added(groupId) and ungroup to removed(groupId)", () => {
		expect(
			commandToChange({
				type: "node.group",
				pageId: "p1",
				childIds: ["a", "b"],
				groupId: "g1",
			}),
		).toEqual({ kind: "added", nodeId: "g1", pageId: "p1" });
		expect(commandToChange({ type: "node.ungroup", groupId: "g1" })).toEqual({
			kind: "removed",
			nodeId: "g1",
		});
	});

	it("maps page commands to page records", () => {
		const page = createPage({});
		expect(commandToChange({ type: "page.create", page })).toEqual({
			kind: "page",
			pageId: page.id,
			op: "create",
		});
		expect(commandToChange({ type: "page.delete", pageId: "p1" })).toEqual({
			kind: "page",
			pageId: "p1",
			op: "delete",
		});
		expect(
			commandToChange({
				type: "page.rename",
				pageId: "p1",
				from: "A",
				to: "B",
			}),
		).toEqual({ kind: "page", pageId: "p1", op: "rename" });
		expect(
			commandToChange({ type: "page.reorder", pageId: "p1", from: 0, to: 1 }),
		).toEqual({ kind: "page", pageId: "p1", op: "reorder" });
	});
});

describe("commandToChangeRecord", () => {
	it("backfills pageId via IR lookup for commands that omit it", () => {
		const { ir, pageId } = makeIR();
		const record = commandToChangeRecord(
			{
				type: "node.move",
				nodeId: "r1",
				from: { x: 0, y: 0 },
				to: { x: 10, y: 0 },
			},
			ir,
		);
		expect(record?.pageId).toBe(pageId);
		expect(record?.nodeIds).toEqual(["r1"]);
	});

	it("uses the command's own pageId when present, without needing a lookup", () => {
		const { ir } = makeIR();
		const node = createRect({ bounds: { width: 1, height: 1 } });
		const record = commandToChangeRecord(
			{ type: "node.create", node, pageId: "some-other-page" },
			ir,
		);
		expect(record?.pageId).toBe("some-other-page");
	});

	it("resolves pageId for node.delete/node.ungroup via IR lookup", () => {
		const { ir, pageId } = makeIR();
		const del = commandToChangeRecord(
			{ type: "node.delete", nodeId: "r1" },
			ir,
		);
		expect(del?.pageId).toBe(pageId);

		const group = insertGroupFixture(ir);
		const ungroup = commandToChangeRecord(
			{ type: "node.ungroup", groupId: group.groupId },
			group.ir,
		);
		expect(ungroup?.pageId).toBe(pageId);
	});

	it("throws when the node cannot be found in the supplied IR", () => {
		const { ir } = makeIR();
		expect(() =>
			commandToChangeRecord(
				{
					type: "node.move",
					nodeId: "ghost",
					from: { x: 0, y: 0 },
					to: { x: 1, y: 1 },
				},
				ir,
			),
		).toThrow();
	});

	it("defaults actorId/source/sequence and generates a commandId", () => {
		const { ir } = makeIR();
		const record = commandToChangeRecord(
			{ type: "node.rotate", nodeId: "r1", from: 0, to: 30 },
			ir,
		);
		expect(record?.actorId).toBe("local");
		expect(record?.source).toBe("local");
		expect(record?.sequence).toBe(0);
		expect(typeof record?.commandId).toBe("string");
		expect(record?.commandId.length).toBeGreaterThan(0);
		expect(record?.command).toEqual({
			type: "node.rotate",
			nodeId: "r1",
			from: 0,
			to: 30,
		});
	});

	it("honors explicit actorId/source/sequence/commandId overrides", () => {
		const { ir } = makeIR();
		const record = commandToChangeRecord(
			{ type: "node.rotate", nodeId: "r1", from: 0, to: 30 },
			ir,
			{ actorId: "peer-1", source: "remote", sequence: 7, commandId: "c-1" },
		);
		expect(record).toMatchObject({
			actorId: "peer-1",
			source: "remote",
			sequence: 7,
			commandId: "c-1",
		});
	});

	it("returns null for a batch, mirroring commandToChange", () => {
		const { ir } = makeIR();
		expect(
			commandToChangeRecord({ type: "batch", commands: [] }, ir),
		).toBeNull();
	});

	it("reports an empty nodeIds array for page-kind changes", () => {
		const { ir } = makeIR();
		const record = commandToChangeRecord(
			{ type: "page.delete", pageId: "p1" },
			ir,
		);
		expect(record?.nodeIds).toEqual([]);
		expect(record?.pageId).toBe("p1");
	});
});

describe("replayChanges", () => {
	it("deterministically reproduces the IR from a sequence of records", () => {
		const { ir: ir0 } = makeIR();
		const moveCmd = {
			type: "node.move" as const,
			nodeId: "r1",
			from: { x: 0, y: 0 },
			to: { x: 10, y: 4 },
		};
		const rotateCmd = {
			type: "node.rotate" as const,
			nodeId: "r1",
			from: 0,
			to: 90,
		};
		// A fixed clock — `applyCommand` stamps `updatedAt` from wall-clock
		// time by default, which would make `irDirect` and `replayed` differ
		// by a millisecond or two under load even though both apply the
		// exact same commands in the exact same order.
		const now = () => "2026-01-01T00:00:00.000Z";
		const { ir: irAfterMove } = applyCommand(ir0, moveCmd, { now });
		const { ir: irDirect } = applyCommand(irAfterMove, rotateCmd, { now });

		const records = [
			commandToChangeRecord(moveCmd, ir0, { now }),
			commandToChangeRecord(rotateCmd, irAfterMove, { now }),
		].filter((r) => r !== null);

		const replayed = replayChanges(ir0, records, { now });
		expect(replayed).toEqual(irDirect);

		const replayedNode = findNode(replayed, "r1")?.node;
		expect(replayedNode?.transform.x).toBe(10);
		expect(replayedNode?.transform.y).toBe(4);
		expect(replayedNode?.transform.rotation).toBe(90);
	});

	it("is a no-op for an empty record list", () => {
		const { ir } = makeIR();
		expect(replayChanges(ir, [])).toEqual(ir);
	});
});

function insertGroupFixture(ir: CanvasIR): { ir: CanvasIR; groupId: string } {
	const { ir: grouped } = applyCommand(ir, {
		type: "node.group",
		pageId: "p1",
		childIds: ["r1"],
		groupId: "g1",
	});
	return { ir: grouped, groupId: "g1" };
}

describe("createChangeEmitter", () => {
	it("delivers emitted batches to subscribers and stops after unsubscribe", () => {
		const emitter = createChangeEmitter();
		const received: CanvasChange[][] = [];
		const unsub = emitter.subscribe((changes) => received.push([...changes]));

		const batch: CanvasChange[] = [
			{ kind: "transform", nodeId: "n1", dx: 1, dy: 0, drot: 0 },
		];
		emitter.emit(batch);
		expect(received).toHaveLength(1);
		expect(received[0]).toEqual(batch);

		unsub();
		emitter.emit([{ kind: "removed", nodeId: "n1" }]);
		expect(received).toHaveLength(1);
	});

	it("supports multiple independent subscribers", () => {
		const emitter = createChangeEmitter();
		let a = 0;
		let b = 0;
		emitter.subscribe(() => {
			a++;
		});
		emitter.subscribe(() => {
			b++;
		});
		emitter.emit([]);
		expect(a).toBe(1);
		expect(b).toBe(1);
	});
});
