import { describe, expect, it } from "vitest";
import { createPage, createRect } from "../../ir/builders.js";
import {
	type CanvasChange,
	commandToChange,
	createChangeEmitter,
} from "../change-events.js";

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
