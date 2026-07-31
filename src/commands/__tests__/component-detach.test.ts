/**
 * plan 0023 M3-07 (T-DET-1/T-DET-2): component-instance.detach materializes
 * a fully-resolved instance in place — nested instances expanded
 * recursively, overrides baked in, Auto Layout intent preserved, the Flow
 * slot (`layoutItem`) kept — with an exact inverse restoring the instance
 * (AC-008, INV-12).
 */

import { describe, expect, it } from "vitest";
import { buildDetachCommand } from "../../component-ops/detach.js";
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
	CanvasComponentDefinition,
	CanvasFrameNode,
	CanvasIR,
	CanvasNode,
	CanvasTextNode,
} from "../../ir/types.js";
import { findNodeInSubtree, isContainerNode } from "../../ir/walkers.js";
import { applyCommand } from "../runtime.js";

const NOW = () => "2026-07-29T00:00:00.000Z";

function stripIds(node: CanvasNode): unknown {
	const { id: _id, ...rest } = node as CanvasNode & { children?: CanvasNode[] };
	if ("children" in rest && Array.isArray(rest.children)) {
		return { ...rest, children: rest.children.map(stripIds) };
	}
	return rest;
}

function collectIds(node: CanvasNode, out: string[] = []): string[] {
	out.push(node.id);
	if (isContainerNode(node)) {
		for (const child of node.children) collectIds(child, out);
	}
	return out;
}

function hasInstanceNodes(node: CanvasNode): boolean {
	if (node.type === "component-instance") return true;
	return isContainerNode(node) ? node.children.some(hasInstanceNodes) : false;
}

function sampleIR(): CanvasIR {
	const inner: CanvasComponentDefinition = {
		id: "cmp-inner",
		name: "Inner",
		revision: 1,
		root: createFrame({
			id: "i-root",
			bounds: { width: 40, height: 20 },
			children: [
				createText({
					id: "i-txt",
					bounds: { width: 40, height: 20 },
					text: "inner",
				}),
			],
		}),
		properties: [
			{
				id: "p-txt",
				name: "Text",
				nodeId: "i-txt",
				kind: "text",
				targetKind: "text",
			},
		],
	};
	const outerRoot = createFrame({
		id: "o-root",
		bounds: { width: 100, height: 80 },
		children: [
			createRect({ id: "o-rect", bounds: { width: 10, height: 10 } }),
			createComponentInstance({
				id: "nested-i",
				componentId: "cmp-inner",
				bounds: { width: 40, height: 20 },
				overrides: {
					"p-txt": {
						kind: "text",
						value: { kind: "plain", text: "overridden!" },
					},
				},
			}),
		],
	});
	const outer: CanvasComponentDefinition = {
		id: "cmp-outer",
		name: "Outer",
		revision: 2,
		root: {
			...outerRoot,
			autoLayout: {
				version: 1,
				direction: "column",
				padding: { top: 4, right: 4, bottom: 4, left: 4 },
				gap: 6,
				primaryAlign: "start",
				crossAlign: "start",
			},
		},
		properties: [],
	};
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children: [
			createRect({ id: "sib", bounds: { width: 5, height: 5 } }),
			createComponentInstance({
				id: "inst-o",
				componentId: "cmp-outer",
				transform: { x: 30, y: 40 },
				bounds: { width: 100, height: 80 },
				layoutItem: { widthSizing: "hug" },
			}),
		],
	});
	const ir = createCanvasIR({ id: "ir-1", pages: [page], now: NOW });
	return { ...ir, components: { "cmp-inner": inner, "cmp-outer": outer } };
}

function pageChild(ir: CanvasIR, index: number): CanvasNode {
	const child = ir.pages[0]?.root.children[index];
	if (!child) throw new Error(`missing page child ${index}`);
	return child;
}

describe("component-instance.detach (T-DET-1/T-DET-2)", () => {
	it("materializes the full resolution in place: same slot, same id, same appearance", () => {
		const ir = sampleIR();
		const resolved = resolveComponentInstance(
			ir.components,
			pageChild(ir, 1) as Parameters<typeof resolveComponentInstance>[1],
		);
		const detached = applyCommand(
			ir,
			{ type: "component-instance.detach", nodeId: "inst-o" },
			{ now: NOW },
		);
		const materialized = pageChild(detached.ir, 1);
		// Same slot, same persistent id, instance placement preserved.
		expect(materialized.id).toBe("inst-o");
		expect(materialized.transform).toEqual({
			x: 30,
			y: 40,
			rotation: 0,
			scaleX: 1,
			scaleY: 1,
		});
		expect(materialized.bounds).toEqual({ width: 100, height: 80 });
		// The Flow slot survives on the materialized root (T-DET-2).
		expect(materialized.layoutItem).toEqual({ widthSizing: "hug" });
		// INV-12: structurally identical to the resolution it came from.
		expect(stripIds(materialized)).toEqual(stripIds(resolved.root));
		// Recursive: no component-instance nodes remain anywhere.
		expect(hasInstanceNodes(materialized)).toBe(false);
		// Auto Layout intent came through; the override is baked into content.
		expect((materialized as CanvasFrameNode).autoLayout?.direction).toBe(
			"column",
		);
		const texts: CanvasTextNode[] = [];
		const collect = (node: CanvasNode): void => {
			if (node.type === "text") texts.push(node);
			if (isContainerNode(node)) node.children.forEach(collect);
		};
		collect(materialized);
		expect(texts.map((t) => t.text)).toEqual(["overridden!"]);
		// The Registry is untouched — definitions and revisions unchanged.
		expect(detached.ir.components).toBe(ir.components);
	});

	it("undo restores the instance node exactly (AC-008)", () => {
		const ir = sampleIR();
		const detached = applyCommand(
			ir,
			{ type: "component-instance.detach", nodeId: "inst-o" },
			{ now: NOW },
		);
		const undone = applyCommand(detached.ir, detached.inverse, { now: NOW });
		expect(undone.ir.pages).toEqual(ir.pages);
		expect(undone.ir.components).toBe(ir.components);
	});

	it("fails atomically when the Source is missing or a boundary degrades", () => {
		const ir = sampleIR();
		const broken = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "inst-o",
				kind: "component-instance",
				patch: { source: { kind: "local", componentId: "cmp-gone" } },
			},
			{ now: NOW },
		).ir;
		expect(() =>
			applyCommand(broken, {
				type: "component-instance.detach",
				nodeId: "inst-o",
			}),
		).toThrowError(expect.objectContaining({ code: "invariant-violated" }));
	});

	it("a locked instance blocks detach under enforceLocked", () => {
		const ir = sampleIR();
		const locked = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "inst-o",
				kind: "component-instance",
				patch: { locked: true },
			},
			{ now: NOW },
		).ir;
		expect(() =>
			applyCommand(
				locked,
				{ type: "component-instance.detach", nodeId: "inst-o" },
				{ enforceLocked: true },
			),
		).toThrowError(expect.objectContaining({ code: "node-locked" }));
	});

	it("rejects a nodeIds allocation colliding with an existing document id", () => {
		const ir = sampleIR();
		const resolved = resolveComponentInstance(
			ir.components,
			pageChild(ir, 1) as Parameters<typeof resolveComponentInstance>[1],
		);
		const firstVirtualChild = (resolved.root as CanvasFrameNode).children[0]
			?.id as string;
		expect(() =>
			applyCommand(ir, {
				type: "component-instance.detach",
				nodeId: "inst-o",
				nodeIds: { [firstVirtualChild]: "sib" },
			}),
		).toThrowError(/already exists/);
	});
});

describe("buildDetachCommand (component-ops)", () => {
	it("allocates every id through one injected factory and returns the complete map", () => {
		const ir = sampleIR();
		let n = 0;
		const plan = buildDetachCommand(ir, "inst-o", {
			idFactory: () => `det-${++n}`,
		});
		expect(plan.command.location).toEqual({ kind: "page", id: "p1" });
		const { ir: next } = applyCommand(ir, plan.command, { now: NOW });
		const materialized = pageChild(next, 1);
		const ids = collectIds(materialized);
		// The root kept the instance id; every descendant id came from the map.
		expect(ids[0]).toBe("inst-o");
		const allocated = new Set(plan.idMap.values());
		for (const id of ids) {
			expect(allocated.has(id), `id "${id}" missing from the plan map`).toBe(
				true,
			);
		}
		expect(allocated.size).toBe(ids.length);
		expect(ids.slice(1).every((id) => id.startsWith("det-"))).toBe(true);
	});

	it("refuses to plan a degraded resolution", () => {
		const ir = sampleIR();
		const broken = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "inst-o",
				kind: "component-instance",
				patch: { source: { kind: "local", componentId: "cmp-gone" } },
			},
			{ now: NOW },
		).ir;
		expect(() => buildDetachCommand(broken, "inst-o")).toThrowError(
			expect.objectContaining({ code: "invariant-violated" }),
		);
	});
});
