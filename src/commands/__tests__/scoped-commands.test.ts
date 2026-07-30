/**
 * plan 0023 M3-02/M3-03: node commands carry `location` into a Component
 * Source tree through the SAME handlers pages use; one applied command or
 * batch/transaction bumps the Source `revision` exactly once; Source-scoped
 * commands surface as the ONE new `component` change kind while instance
 * edits stay ordinary node changes.
 */

import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createGroup,
	createImage,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasAutoLayout,
	CanvasComponentDefinition,
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasRectNode,
} from "../../ir/types.js";
import type { CanvasDocumentLocation } from "../../ir/walkers.js";
import { findNodeInSubtree } from "../../ir/walkers.js";
import {
	commandToChange,
	commandToChangeRecord,
	replayChanges,
} from "../change-events.js";
import { applyCommand, CanvasCommandError } from "../runtime.js";
import { applyCommands } from "../transaction.js";
import type { CanvasCommand } from "../types.js";

const NOW = () => "2026-07-29T00:00:00.000Z";
const AT_CMP: CanvasDocumentLocation = { kind: "component", id: "cmp-a" };

const LAYOUT: CanvasAutoLayout = {
	version: 1,
	direction: "row",
	padding: { top: 0, right: 0, bottom: 0, left: 0 },
	gap: 4,
	primaryAlign: "start",
	crossAlign: "start",
};

function sampleIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children: [
			createRect({ id: "r1", bounds: { width: 10, height: 10 }, fill: "#f00" }),
			createComponentInstance({
				id: "inst1",
				componentId: "cmp-a",
				bounds: { width: 120, height: 90 },
			}),
		],
	});
	const definition: CanvasComponentDefinition = {
		id: "cmp-a",
		name: "Card",
		revision: 3,
		root: createFrame({
			id: "croot",
			bounds: { width: 120, height: 90 },
			children: [
				createRect({
					id: "c1",
					bounds: { width: 10, height: 10 },
					fill: "#00f",
				}),
				createGroup({
					id: "cg",
					bounds: { width: 40, height: 40 },
					children: [
						createText({
							id: "ct1",
							bounds: { width: 80, height: 20 },
							text: "cta",
						}),
					],
				}),
				createImage({
					id: "cimg",
					bounds: { width: 20, height: 20 },
					assetId: "a1",
				}),
				createFrame({
					id: "cfr",
					bounds: { width: 30, height: 30 },
					children: [],
				}),
			],
		}),
		properties: [],
	};
	const ir = createCanvasIR({ id: "ir-1", pages: [page], now: NOW });
	return {
		...ir,
		assets: {
			a1: { id: "a1", uri: "u1" },
			a2: { id: "a2", uri: "u2" },
		},
		components: { "cmp-a": definition },
	};
}

function definition(ir: CanvasIR, id = "cmp-a"): CanvasComponentDefinition {
	const def = ir.components?.[id];
	if (!def) throw new Error(`missing definition ${id}`);
	return def;
}

function defNode(ir: CanvasIR, nodeId: string): CanvasNode {
	const found = findNodeInSubtree(definition(ir).root, nodeId);
	if (!found) throw new Error(`missing definition node ${nodeId}`);
	return found.node;
}

interface ScopedCase {
	name: string;
	cmd: CanvasCommand;
	assert: (next: CanvasIR) => void;
}

const CASES: ScopedCase[] = [
	{
		name: "node.create",
		cmd: {
			type: "node.create",
			node: createRect({ id: "c-new", bounds: { width: 5, height: 5 } }),
			parentId: "croot",
			location: AT_CMP,
		},
		assert: (next) => {
			expect(defNode(next, "c-new").type).toBe("rect");
		},
	},
	{
		name: "node.delete",
		cmd: { type: "node.delete", nodeId: "c1", location: AT_CMP },
		assert: (next) => {
			expect(findNodeInSubtree(definition(next).root, "c1")).toBeNull();
		},
	},
	{
		name: "node.update",
		cmd: {
			type: "node.update",
			nodeId: "c1",
			kind: "rect",
			patch: { fill: "#0ff" },
			location: AT_CMP,
		},
		assert: (next) => {
			expect((defNode(next, "c1") as CanvasRectNode).fill).toBe("#0ff");
		},
	},
	{
		name: "node.move",
		cmd: {
			type: "node.move",
			nodeId: "c1",
			from: { x: 0, y: 0 },
			to: { x: 7, y: 8 },
			location: AT_CMP,
		},
		assert: (next) => {
			expect(defNode(next, "c1").transform.x).toBe(7);
		},
	},
	{
		name: "node.resize",
		cmd: {
			type: "node.resize",
			nodeId: "c1",
			from: { x: 0, y: 0, width: 10, height: 10 },
			to: { x: 0, y: 0, width: 42, height: 24 },
			location: AT_CMP,
		},
		assert: (next) => {
			expect(defNode(next, "c1").bounds.width).toBe(42);
		},
	},
	{
		name: "node.rotate",
		cmd: {
			type: "node.rotate",
			nodeId: "c1",
			from: 0,
			to: 45,
			location: AT_CMP,
		},
		assert: (next) => {
			expect(defNode(next, "c1").transform.rotation).toBe(45);
		},
	},
	{
		name: "node.reorder",
		cmd: { type: "node.reorder", nodeId: "c1", toIndex: 1, location: AT_CMP },
		assert: (next) => {
			expect(
				(definition(next).root as CanvasFrameNode).children.map((c) => c.id),
			).toEqual(["cg", "c1", "cimg", "cfr"]);
		},
	},
	{
		name: "node.reparent",
		cmd: {
			type: "node.reparent",
			nodeId: "c1",
			toParentId: "cg",
			toIndex: 0,
			location: AT_CMP,
		},
		assert: (next) => {
			expect(
				(defNode(next, "cg") as CanvasGroupNode).children.map((c) => c.id),
			).toEqual(["c1", "ct1"]);
		},
	},
	{
		name: "node.applyStyle",
		cmd: {
			type: "node.applyStyle",
			nodeId: "c1",
			style: { fill: "#abcdef" },
			location: AT_CMP,
		},
		assert: (next) => {
			expect((defNode(next, "c1") as CanvasRectNode).fill).toBe("#abcdef");
		},
	},
	{
		name: "image.replace",
		cmd: {
			type: "image.replace",
			nodeId: "cimg",
			fromAssetId: "a1",
			toAssetId: "a2",
			location: AT_CMP,
		},
		assert: (next) => {
			expect((defNode(next, "cimg") as { assetId: string }).assetId).toBe("a2");
		},
	},
	{
		name: "node.group",
		cmd: {
			type: "node.group",
			childIds: ["c1", "cimg"],
			groupId: "c-grp",
			location: AT_CMP,
		},
		assert: (next) => {
			expect(
				(defNode(next, "c-grp") as CanvasGroupNode).children.map((c) => c.id),
			).toEqual(["c1", "cimg"]);
		},
	},
	{
		name: "node.ungroup",
		cmd: { type: "node.ungroup", groupId: "cg", location: AT_CMP },
		assert: (next) => {
			expect(findNodeInSubtree(definition(next).root, "cg")).toBeNull();
			expect(defNode(next, "ct1").type).toBe("text");
		},
	},
	{
		name: "frame.set-layout",
		cmd: {
			type: "frame.set-layout",
			nodeId: "cfr",
			layout: LAYOUT,
			location: AT_CMP,
		},
		assert: (next) => {
			expect((defNode(next, "cfr") as CanvasFrameNode).autoLayout).toEqual(
				LAYOUT,
			);
		},
	},
];

describe("scoped node commands — apply, invert, settle (T-CMD parity)", () => {
	it.each(
		CASES,
	)("$name mutates the Source, bumps revision once, and undoes exactly", ({
		cmd,
		assert,
	}) => {
		const ir = sampleIR();
		const originalRoot = definition(ir).root;
		const forward = applyCommand(ir, cmd, { now: NOW });
		assert(forward.ir);
		// Exactly one bump for one applied command.
		expect(definition(forward.ir).revision).toBe(4);
		// The page tree is untouched by a Source-scoped command.
		expect(forward.ir.pages).toBe(ir.pages);
		// The inverse targets the same tree...
		expect(
			(forward.inverse as { location?: CanvasDocumentLocation }).location,
		).toEqual(AT_CMP);
		// ...and restores the Source tree byte-identically. Revision is
		// monotonic (undo is itself a Source edit and must propagate), so it
		// bumps again rather than restoring.
		const undone = applyCommand(forward.ir, forward.inverse, { now: NOW });
		expect(definition(undone.ir).root).toEqual(originalRoot);
		expect(definition(undone.ir).revision).toBe(5);
	});

	it("frame.remove-layout round-trips the layout intent in a Source tree", () => {
		const ir = sampleIR();
		const withLayout = applyCommand(
			ir,
			{
				type: "frame.set-layout",
				nodeId: "cfr",
				layout: LAYOUT,
				location: AT_CMP,
			},
			{ now: NOW },
		).ir;
		const removed = applyCommand(
			withLayout,
			{ type: "frame.remove-layout", nodeId: "cfr", location: AT_CMP },
			{ now: NOW },
		);
		expect(
			(defNode(removed.ir, "cfr") as CanvasFrameNode).autoLayout,
		).toBeUndefined();
		const restored = applyCommand(removed.ir, removed.inverse, { now: NOW });
		expect((defNode(restored.ir, "cfr") as CanvasFrameNode).autoLayout).toEqual(
			LAYOUT,
		);
	});
});

describe("revision settle semantics", () => {
	it("a batch of Source edits bumps the revision exactly once", () => {
		const ir = sampleIR();
		const { ir: next } = applyCommand(
			ir,
			{
				type: "batch",
				commands: [
					{
						type: "node.update",
						nodeId: "c1",
						kind: "rect",
						patch: { fill: "#111" },
						location: AT_CMP,
					},
					{
						type: "node.move",
						nodeId: "c1",
						from: { x: 0, y: 0 },
						to: { x: 1, y: 1 },
						location: AT_CMP,
					},
					{ type: "node.reorder", nodeId: "cg", toIndex: 0, location: AT_CMP },
				],
			},
			{ now: NOW },
		);
		expect(definition(next).revision).toBe(4);
	});

	it("an applyCommands transaction of Source edits settles once at its boundary", () => {
		const ir = sampleIR();
		const { ir: next } = applyCommands(
			ir,
			[
				{
					type: "node.update",
					nodeId: "c1",
					kind: "rect",
					patch: { fill: "#222" },
					location: AT_CMP,
				},
				{
					type: "node.rotate",
					nodeId: "c1",
					from: 0,
					to: 10,
					location: AT_CMP,
				},
			],
			{ now: NOW },
		);
		expect(definition(next).revision).toBe(4);
	});

	it("page-tree commands never touch the registry", () => {
		const ir = sampleIR();
		const { ir: next } = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "r1",
				kind: "rect",
				patch: { fill: "#333" },
			},
			{ now: NOW },
		);
		expect(next.components).toBe(ir.components);
	});

	it("an instance override edit is a page edit: no revision bump", () => {
		const ir = sampleIR();
		const { ir: next } = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "inst1",
				kind: "component-instance",
				patch: {
					overrides: { p1: { kind: "visibility", visible: false } },
				},
			},
			{ now: NOW },
		);
		expect(definition(next).revision).toBe(3);
		expect(next.components).toBe(ir.components);
	});
});

describe("scoped command guards", () => {
	it("throws location-not-found for a missing definition", () => {
		const ir = sampleIR();
		expect(() =>
			applyCommand(ir, {
				type: "node.delete",
				nodeId: "c1",
				location: { kind: "component", id: "nope" },
			}),
		).toThrowError(expect.objectContaining({ code: "location-not-found" }));
	});

	it("a Source-scoped command cannot see page nodes, and vice versa", () => {
		const ir = sampleIR();
		expect(() =>
			applyCommand(ir, { type: "node.delete", nodeId: "r1", location: AT_CMP }),
		).toThrowError(CanvasCommandError);
		expect(() =>
			applyCommand(ir, { type: "node.delete", nodeId: "c1" }),
		).toThrowError(CanvasCommandError);
	});

	it("a locked Source node blocks Source-scope edits under enforceLocked", () => {
		const ir = sampleIR();
		const locked = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "c1",
				kind: "rect",
				patch: { locked: true },
				location: AT_CMP,
			},
			{ now: NOW },
		).ir;
		expect(() =>
			applyCommand(
				locked,
				{
					type: "node.move",
					nodeId: "c1",
					from: { x: 0, y: 0 },
					to: { x: 5, y: 5 },
					location: AT_CMP,
				},
				{ enforceLocked: true },
			),
		).toThrowError(expect.objectContaining({ code: "node-locked" }));
	});

	it("node.create without pageId or location is a typed error", () => {
		const ir = sampleIR();
		expect(() =>
			applyCommand(ir, {
				type: "node.create",
				node: createRect({ id: "x", bounds: { width: 1, height: 1 } }),
			}),
		).toThrowError(expect.objectContaining({ code: "page-not-found" }));
	});
});

describe("CanvasChange component kind (M3-03)", () => {
	it("a Source-scoped node command maps to the component kind with op source-edit", () => {
		expect(
			commandToChange({
				type: "node.update",
				nodeId: "c1",
				kind: "rect",
				patch: { fill: "#000" },
				location: AT_CMP,
			}),
		).toEqual({ kind: "component", componentId: "cmp-a", op: "source-edit" });
	});

	it("instance override edits stay ordinary node changes", () => {
		expect(
			commandToChange({
				type: "node.update",
				nodeId: "inst1",
				kind: "component-instance",
				patch: { overrides: {} },
			}),
		).toEqual({ kind: "updated", nodeId: "inst1", keys: ["overrides"] });
	});

	it("page-scoped locations keep their ordinary node records", () => {
		expect(
			commandToChange({
				type: "node.update",
				nodeId: "r1",
				kind: "rect",
				patch: { fill: "#000" },
				location: { kind: "page", id: "p1" },
			}),
		).toEqual({ kind: "updated", nodeId: "r1", keys: ["fill"] });
	});

	it("a component change record is document-level: no pageId, no nodeIds", () => {
		const ir = sampleIR();
		const record = commandToChangeRecord(
			{ type: "node.delete", nodeId: "c1", location: AT_CMP },
			ir,
			{ now: NOW, commandIdFactory: () => "cmd-1" },
		);
		expect(record?.change.kind).toBe("component");
		expect(record?.pageId).toBeUndefined();
		expect(record?.nodeIds).toEqual([]);
	});

	it("replays a mixed page+component stream to identical content", () => {
		const ir = sampleIR();
		const commands: CanvasCommand[] = [
			{
				type: "node.update",
				nodeId: "r1",
				kind: "rect",
				patch: { fill: "#444" },
			},
			{
				type: "node.update",
				nodeId: "c1",
				kind: "rect",
				patch: { fill: "#555" },
				location: AT_CMP,
			},
			{
				type: "node.move",
				nodeId: "inst1",
				from: { x: 0, y: 0 },
				to: { x: 30, y: 40 },
			},
		];
		const direct = applyCommands(ir, commands, {
			now: NOW,
			commandIdFactory: () => "cmd",
		});
		expect(direct.records).toHaveLength(3);
		const replayed = replayChanges(ir, direct.records, { now: NOW });
		// Content is identical; the Source revision is a monotonic propagation
		// signal and may run ahead when replaying per-record what one
		// transaction settled once — compare content with revisions normalized.
		expect(replayed.pages).toEqual(direct.ir.pages);
		expect(definition(replayed).root).toEqual(definition(direct.ir).root);
		expect(definition(replayed).revision).toBeGreaterThanOrEqual(
			definition(direct.ir).revision,
		);
	});
});
