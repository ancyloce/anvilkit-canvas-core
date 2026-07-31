/**
 * plan 0023 M3-08 (T-DEL-1): the reference index, and "detach all and
 * delete" as ONE atomic batch — Source-tree dependents first in reverse
 * topological order, then page instances, then the guarded delete.
 */

import { describe, expect, it } from "vitest";
import { applyCommand } from "../../commands/runtime.js";
import {
	buildComponentReferenceIndex,
	collectNestedComponentIds,
} from "../../components/graph.js";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createGroup,
	createPage,
	createText,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import { findNodeInSubtree } from "../../ir/walkers.js";
import { buildDetachAllAndDeleteCommand } from "../delete.js";

const NOW = () => "2026-07-29T00:00:00.000Z";

function makeIR(): CanvasIR {
	const x: CanvasComponentDefinition = {
		id: "cmp-x",
		name: "X",
		revision: 1,
		root: createFrame({
			id: "x-root",
			bounds: { width: 40, height: 20 },
			children: [
				createText({
					id: "x-txt",
					bounds: { width: 40, height: 20 },
					text: "x",
				}),
			],
		}),
		properties: [
			{
				id: "p-txt",
				name: "Text",
				nodeId: "x-txt",
				kind: "text",
				targetKind: "text",
			},
		],
	};
	const d: CanvasComponentDefinition = {
		id: "cmp-d",
		name: "D",
		revision: 2,
		root: createFrame({
			id: "d-root",
			bounds: { width: 80, height: 40 },
			children: [
				createComponentInstance({
					id: "nested-x",
					componentId: "cmp-x",
					bounds: { width: 40, height: 20 },
					overrides: {
						"p-txt": { kind: "text", value: { kind: "plain", text: "in D" } },
					},
				}),
			],
		}),
		properties: [],
	};
	const e: CanvasComponentDefinition = {
		id: "cmp-e",
		name: "E",
		revision: 3,
		root: createFrame({
			id: "e-root",
			bounds: { width: 120, height: 60 },
			children: [
				createComponentInstance({
					id: "nested-d",
					componentId: "cmp-d",
					bounds: { width: 80, height: 40 },
				}),
				createComponentInstance({
					id: "nested-x2",
					componentId: "cmp-x",
					bounds: { width: 40, height: 20 },
				}),
			],
		}),
		properties: [],
	};
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children: [
			createComponentInstance({
				id: "inst-x",
				componentId: "cmp-x",
				bounds: { width: 40, height: 20 },
			}),
			createComponentInstance({
				id: "inst-d",
				componentId: "cmp-d",
				bounds: { width: 80, height: 40 },
			}),
		],
	});
	const ir = createCanvasIR({ id: "ir-1", pages: [page], now: NOW });
	return { ...ir, components: { "cmp-x": x, "cmp-d": d, "cmp-e": e } };
}

function definition(ir: CanvasIR, id: string): CanvasComponentDefinition {
	const def = ir.components?.[id];
	if (!def) throw new Error(`missing definition ${id}`);
	return def;
}

function pageChild(ir: CanvasIR, index: number): CanvasNode {
	const child = ir.pages[0]?.root.children[index];
	if (!child) throw new Error(`missing page child ${index}`);
	return child;
}

describe("buildComponentReferenceIndex", () => {
	it("indexes page instances and Source dependents per component", () => {
		const index = buildComponentReferenceIndex(makeIR());
		expect(index.pageInstancesByComponent.get("cmp-x")).toEqual([
			{ pageId: "p1", instanceId: "inst-x" },
		]);
		expect(index.pageInstancesByComponent.get("cmp-d")).toEqual([
			{ pageId: "p1", instanceId: "inst-d" },
		]);
		expect(index.sourceDependenciesByComponent.get("cmp-x")).toEqual([
			{ componentId: "cmp-d", instanceId: "nested-x" },
			{ componentId: "cmp-e", instanceId: "nested-x2" },
		]);
		expect(index.sourceDependenciesByComponent.get("cmp-d")).toEqual([
			{ componentId: "cmp-e", instanceId: "nested-d" },
		]);
		expect(index.pageInstancesByComponent.get("cmp-e")).toBeUndefined();
	});
});

describe("buildDetachAllAndDeleteCommand", () => {
	it("orders detaches hosts-reverse-topologically, then page instances, then the delete", () => {
		const plan = buildDetachAllAndDeleteCommand(makeIR(), "cmp-x");
		const shapes = plan.command.commands.map((cmd) =>
			cmd.type === "component-instance.detach"
				? `${cmd.type}:${cmd.nodeId}@${cmd.location?.kind}:${cmd.location?.id}`
				: cmd.type,
		);
		// Dependency-first topo is [x, d, e]; reversed hosts → e before d.
		expect(shapes).toEqual([
			"component-instance.detach:nested-x2@component:cmp-e",
			"component-instance.detach:nested-x@component:cmp-d",
			"component-instance.detach:inst-x@page:p1",
			"component.delete",
		]);
		expect(plan.detachPlans).toHaveLength(3);
	});

	it("applies as ONE batch: every dependent materialized, definition gone, others intact", () => {
		const ir = makeIR();
		const plan = buildDetachAllAndDeleteCommand(ir, "cmp-x", {
			idFactory: (() => {
				let n = 0;
				return () => `dd-${++n}`;
			})(),
		});
		const applied = applyCommand(ir, plan.command, { now: NOW });
		// The definition is gone; d and e survive with NO references to x.
		expect(applied.ir.components?.["cmp-x"]).toBeUndefined();
		expect(
			collectNestedComponentIds(definition(applied.ir, "cmp-d").root),
		).toEqual([]);
		expect(
			collectNestedComponentIds(definition(applied.ir, "cmp-e").root),
		).toEqual(["cmp-d"]);
		// The materialized copy inside D carries the baked override. (The root
		// keeps the instance's id "nested-x"; its text child got a factory id.)
		const dRoot = definition(applied.ir, "cmp-d").root;
		const materializedInD = findNodeInSubtree(dRoot, "nested-x")?.node;
		expect(materializedInD?.type).toBe("frame");
		const textsInD: string[] = [];
		const collectTexts = (node: CanvasNode): void => {
			if (node.type === "text") textsInD.push(node.text);
			const children = (node as { children?: readonly CanvasNode[] }).children;
			if (children) children.forEach(collectTexts);
		};
		if (materializedInD) collectTexts(materializedInD);
		expect(textsInD).toEqual(["in D"]);
		// Page: inst-x materialized in place, inst-d untouched.
		expect(pageChild(applied.ir, 0).id).toBe("inst-x");
		expect(pageChild(applied.ir, 0).type).toBe("frame");
		expect(pageChild(applied.ir, 1).type).toBe("component-instance");
		// One batch = one revision settle per touched host.
		expect(definition(applied.ir, "cmp-d").revision).toBe(3);
		expect(definition(applied.ir, "cmp-e").revision).toBe(4);
	});

	it("one undo restores the definition, every instance, and the exact Source trees", () => {
		const ir = makeIR();
		const plan = buildDetachAllAndDeleteCommand(ir, "cmp-x");
		const applied = applyCommand(ir, plan.command, { now: NOW });
		const undone = applyCommand(applied.ir, applied.inverse, { now: NOW });
		expect(undone.ir.pages).toEqual(ir.pages);
		expect(definition(undone.ir, "cmp-x")).toEqual(definition(ir, "cmp-x"));
		expect(definition(undone.ir, "cmp-d").root).toEqual(
			definition(ir, "cmp-d").root,
		);
		expect(definition(undone.ir, "cmp-e").root).toEqual(
			definition(ir, "cmp-e").root,
		);
	});

	it("a stale plan whose materialization fails changes nothing (atomic)", () => {
		const ir = makeIR();
		const plan = buildDetachAllAndDeleteCommand(ir, "cmp-x");
		// Tamper AFTER planning: the page instance now points at a ghost, so
		// its detach degrades and the whole batch must abort.
		const tampered = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "inst-x",
				kind: "component-instance",
				patch: { source: { kind: "local", componentId: "cmp-ghost" } },
			},
			{ now: NOW },
		).ir;
		expect(() => applyCommand(tampered, plan.command)).toThrowError(
			expect.objectContaining({ code: "invariant-violated" }),
		);
		// And the guarded delete alone still rejects while references remain.
		expect(() =>
			applyCommand(tampered, {
				type: "component.delete",
				componentId: "cmp-x",
			}),
		).toThrowError(/reference/);
	});

	it("rejects an unknown component", () => {
		expect(() =>
			buildDetachAllAndDeleteCommand(makeIR(), "cmp-nope"),
		).toThrowError(expect.objectContaining({ code: "location-not-found" }));
	});
});
