/**
 * plan 0023 M3-04 + M3-05 (T-CREATE-1): component.create from-selection over
 * all four input shapes — single group, single frame, single leaf,
 * multi-selection — with visual placement unchanged (AC-001), one atomic
 * Undo entry restoring the original nodes byte-identically, and the final
 * component graph validated after the instance is placed.
 */

import { describe, expect, it } from "vitest";
import { resolveComponentInstance } from "../../components/resolve.js";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasComponentInstanceNode,
	CanvasFrameNode,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import { findNodeInSubtree } from "../../ir/walkers.js";
import { applyCommand } from "../runtime.js";
import type { CanvasCommand } from "../types.js";

const NOW = () => "2026-07-29T00:00:00.000Z";

/** Structural comparison that ignores the (deliberately remapped) node ids. */
function stripIds(node: CanvasNode): unknown {
	const { id: _id, ...rest } = node as CanvasNode & { children?: CanvasNode[] };
	if ("children" in rest && Array.isArray(rest.children)) {
		return { ...rest, children: rest.children.map(stripIds) };
	}
	return rest;
}

function sampleIR(children: CanvasNode[]): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children,
	});
	return createCanvasIR({ id: "ir-1", pages: [page], now: NOW });
}

function createCmd(
	selectedNodeIds: string[],
	extra: Partial<
		Extract<CanvasCommand, { type: "component.create"; mode: "from-selection" }>
	> = {},
): CanvasCommand {
	return {
		type: "component.create",
		mode: "from-selection",
		selectedNodeIds,
		componentId: "cmp-new",
		sourceRootId: "src-root",
		firstInstanceId: "inst-1",
		name: "Card",
		...extra,
	};
}

function pageChildren(ir: CanvasIR): readonly CanvasNode[] {
	const root = ir.pages[0]?.root;
	if (!root) throw new Error("missing page root");
	return root.children;
}

function definition(ir: CanvasIR, id = "cmp-new") {
	const def = ir.components?.[id];
	if (!def) throw new Error(`missing definition ${id}`);
	return def;
}

describe("T-CREATE-1 input shapes", () => {
	it("single group: the container is promoted to the Source root; the instance takes its placement", () => {
		const group = createGroup({
			id: "g1",
			name: "Hero",
			transform: { x: 30, y: 40, rotation: 15 },
			bounds: { width: 60, height: 50 },
			zIndex: 2,
			children: [
				createRect({ id: "r-in", bounds: { width: 10, height: 10 } }),
				createText({
					id: "t-in",
					bounds: { width: 40, height: 12 },
					text: "hi",
				}),
			],
		});
		const before = createRect({ id: "sib", bounds: { width: 5, height: 5 } });
		const ir = sampleIR([before, group]);
		const { ir: next } = applyCommand(ir, createCmd(["g1"]), { now: NOW });

		const def = definition(next);
		expect(def.name).toBe("Card");
		expect(def.revision).toBe(1);
		expect(def.root.id).toBe("src-root");
		expect(def.root.type).toBe("group");
		// Identity transform on the root; content structurally identical.
		expect(def.root.transform).toEqual({
			x: 0,
			y: 0,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});
		expect((def.root as CanvasFrameNode).children.map(stripIds)).toEqual(
			group.children.map(stripIds),
		);
		// The instance sits in the group's slot with the group's placement.
		expect(pageChildren(next).map((c) => c.id)).toEqual(["sib", "inst-1"]);
		const instance = pageChildren(next)[1] as CanvasComponentInstanceNode;
		expect(instance.source).toEqual({ kind: "local", componentId: "cmp-new" });
		expect(instance.transform).toEqual(group.transform);
		expect(instance.bounds).toEqual(group.bounds);
		expect(instance.zIndex).toBe(2);
		// AC-001 resolved parity: the composed subtree matches the original
		// container structurally (ids are virtual/remapped by design).
		const resolved = resolveComponentInstance(next.components, instance);
		expect(resolved.issues).toEqual([]);
		expect(stripIds(resolved.root)).toEqual(stripIds(group));
	});

	it("single frame: existing Auto Layout is preserved, never re-inferred", () => {
		const frame = createFrame({
			id: "f1",
			transform: { x: 10, y: 10 },
			bounds: { width: 100, height: 40 },
			children: [createRect({ id: "fr-r", bounds: { width: 10, height: 10 } })],
		});
		const framed: CanvasFrameNode = {
			...frame,
			autoLayout: {
				version: 1,
				direction: "row",
				padding: { top: 0, right: 0, bottom: 0, left: 0 },
				gap: 8,
				primaryAlign: "start",
				crossAlign: "start",
			},
		};
		const ir = sampleIR([framed]);
		const { ir: next } = applyCommand(ir, createCmd(["f1"]), { now: NOW });
		const root = definition(next).root as CanvasFrameNode;
		expect(root.type).toBe("frame");
		expect(root.autoLayout).toEqual(framed.autoLayout);
	});

	it("single leaf: wrapped in a plain frame at the leaf's AABB", () => {
		const leaf = createRect({
			id: "r1",
			transform: { x: 30, y: 40 },
			bounds: { width: 10, height: 10 },
			fill: "#f00",
		});
		const ir = sampleIR([leaf]);
		const { ir: next } = applyCommand(ir, createCmd(["r1"]), { now: NOW });
		const root = definition(next).root as CanvasFrameNode;
		expect(root.type).toBe("frame");
		expect(root.autoLayout).toBeUndefined();
		expect(root.bounds).toEqual({ width: 10, height: 10 });
		expect(root.children).toHaveLength(1);
		expect(root.children[0]?.transform.x).toBe(0);
		expect(root.children[0]?.transform.y).toBe(0);
		const instance = pageChildren(next)[0] as CanvasComponentInstanceNode;
		expect(instance.transform.x).toBe(30);
		expect(instance.transform.y).toBe(40);
		expect(instance.bounds).toEqual({ width: 10, height: 10 });
	});

	it("multi-selection: wrapped at the tight AABB with frame-local children in paint order", () => {
		const a = createRect({
			id: "ra",
			transform: { x: 10, y: 10 },
			bounds: { width: 10, height: 10 },
		});
		const b = createRect({
			id: "rb",
			transform: { x: 40, y: 30 },
			bounds: { width: 20, height: 10 },
		});
		const ir = sampleIR([a, b]);
		const { ir: next } = applyCommand(ir, createCmd(["ra", "rb"]), {
			now: NOW,
		});
		const root = definition(next).root as CanvasFrameNode;
		expect(root.bounds).toEqual({ width: 50, height: 30 });
		expect(root.children.map((c) => c.transform.x)).toEqual([0, 30]);
		expect(root.children.map((c) => c.transform.y)).toEqual([0, 20]);
		const instance = pageChildren(next)[0] as CanvasComponentInstanceNode;
		expect(instance.transform.x).toBe(10);
		expect(instance.transform.y).toBe(10);
		expect(instance.bounds).toEqual({ width: 50, height: 30 });
		expect(pageChildren(next)).toHaveLength(1);
	});
});

describe("atomicity + undo (AC-001)", () => {
	it("one inverse batch restores the original nodes byte-identically and removes the definition", () => {
		const a = createRect({
			id: "ra",
			transform: { x: 10, y: 10 },
			bounds: { width: 10, height: 10 },
		});
		const b = createRect({
			id: "rb",
			transform: { x: 40, y: 30 },
			bounds: { width: 20, height: 10 },
		});
		const sib = createText({
			id: "sib",
			bounds: { width: 30, height: 10 },
			text: "s",
		});
		const ir = sampleIR([a, sib, b]);
		const created = applyCommand(ir, createCmd(["ra", "rb"]), { now: NOW });
		expect(created.inverse.type).toBe("batch");
		const undone = applyCommand(created.ir, created.inverse, { now: NOW });
		expect(undone.ir.pages).toEqual(ir.pages);
		expect(undone.ir.components ?? {}).toEqual({});
	});

	it("a failing graph validation changes nothing (atomic)", () => {
		// Create FROM a Source tree whose selection references the host
		// component: the new definition would close a dependency cycle.
		const ir = sampleIR([]);
		const withHost: CanvasIR = {
			...ir,
			components: {
				"cmp-host": {
					id: "cmp-host",
					name: "Host",
					revision: 1,
					root: createFrame({
						id: "host-root",
						bounds: { width: 100, height: 100 },
						children: [
							createComponentInstance({
								id: "self-inst",
								componentId: "cmp-host",
								bounds: { width: 10, height: 10 },
							}),
						],
					}),
					properties: [],
				},
			},
		};
		expect(() =>
			applyCommand(
				withHost,
				createCmd(["self-inst"], {
					location: { kind: "component", id: "cmp-host" },
				}),
				{ now: NOW },
			),
		).toThrowError(/cycle/);
	});
});

describe("guards", () => {
	it("rejects empty, duplicate, cross-parent, and unknown selections", () => {
		const a = createRect({ id: "ra", bounds: { width: 1, height: 1 } });
		const g = createGroup({
			id: "g1",
			bounds: { width: 10, height: 10 },
			children: [createRect({ id: "inner", bounds: { width: 1, height: 1 } })],
		});
		const ir = sampleIR([a, g]);
		expect(() => applyCommand(ir, createCmd([]))).toThrowError(/at least one/);
		expect(() => applyCommand(ir, createCmd(["ra", "ra"]))).toThrowError(
			/duplicates/,
		);
		expect(() => applyCommand(ir, createCmd(["ra", "inner"]))).toThrowError(
			/same parent/,
		);
		expect(() => applyCommand(ir, createCmd(["nope"]))).toThrowError(
			expect.objectContaining({ code: "node-not-found" }),
		);
	});

	it("rejects colliding caller-allocated ids and existing component ids", () => {
		const a = createRect({ id: "ra", bounds: { width: 1, height: 1 } });
		const ir = sampleIR([a]);
		expect(() =>
			applyCommand(ir, createCmd(["ra"], { firstInstanceId: "pg-root" })),
		).toThrowError(/firstInstanceId/);
		expect(() =>
			applyCommand(ir, createCmd(["ra"], { sourceRootId: "pg-root" })),
		).toThrowError(/sourceRootId/);
		const withCmp = applyCommand(ir, createCmd(["ra"]), { now: NOW }).ir;
		const b = createRect({ id: "rb", bounds: { width: 1, height: 1 } });
		const withB = applyCommand(
			withCmp,
			{ type: "node.create", node: b, pageId: "p1" },
			{ now: NOW },
		).ir;
		expect(() =>
			applyCommand(
				withB,
				createCmd(["rb"], {
					sourceRootId: "src-2",
					firstInstanceId: "inst-2",
				}),
			),
		).toThrowError(/already exists/);
	});

	it("reuse-container demands a single container selection", () => {
		const a = createRect({ id: "ra", bounds: { width: 1, height: 1 } });
		const ir = sampleIR([a]);
		expect(() =>
			applyCommand(ir, createCmd(["ra"], { rootStrategy: "reuse-container" })),
		).toThrowError(/reuse-container/);
	});

	it("creating inside a Source tree bumps the HOST revision once and nests the component", () => {
		const ir = sampleIR([]);
		const withHost: CanvasIR = {
			...ir,
			components: {
				"cmp-host": {
					id: "cmp-host",
					name: "Host",
					revision: 5,
					root: createFrame({
						id: "host-root",
						bounds: { width: 100, height: 100 },
						children: [
							createRect({ id: "host-rect", bounds: { width: 8, height: 8 } }),
						],
					}),
					properties: [],
				},
			},
		};
		const { ir: next } = applyCommand(
			withHost,
			createCmd(["host-rect"], {
				location: { kind: "component", id: "cmp-host" },
			}),
			{ now: NOW },
		);
		expect(definition(next, "cmp-new").revision).toBe(1);
		expect(next.components?.["cmp-host"]?.revision).toBe(6);
		const hostRoot = next.components?.["cmp-host"]?.root;
		expect(
			hostRoot ? findNodeInSubtree(hostRoot, "inst-1")?.node.type : undefined,
		).toBe("component-instance");
	});
});
