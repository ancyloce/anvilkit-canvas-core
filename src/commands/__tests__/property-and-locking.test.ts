/**
 * plan 0023 M3-06 (T-PROP-2) + M3-13 (T-LOCK-1): property authoring commands
 * with the orphan-override lifecycle, and the two independent locks across
 * the Source/instance boundary (TD §5.2).
 */

import { describe, expect, it } from "vitest";
import { applyComponentOverrides } from "../../components/overrides.js";
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
	CanvasComponentProperty,
	CanvasIR,
	CanvasTextNode,
} from "../../ir/types.js";
import { findNodeInSubtree } from "../../ir/walkers.js";
import { applyCommand } from "../runtime.js";

const NOW = () => "2026-07-29T00:00:00.000Z";

const TEXT_PROPERTY: CanvasComponentProperty = {
	id: "prop-title",
	name: "Title",
	nodeId: "a-title",
	kind: "text",
	targetKind: "text",
};

function sampleIR(withProperty = false): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children: [
			createComponentInstance({
				id: "inst-a",
				componentId: "cmp-a",
				bounds: { width: 100, height: 80 },
			}),
		],
	});
	const definition: CanvasComponentDefinition = {
		id: "cmp-a",
		name: "Card",
		revision: 3,
		root: createFrame({
			id: "a-root",
			bounds: { width: 100, height: 80 },
			children: [
				createText({
					id: "a-title",
					bounds: { width: 80, height: 20 },
					text: "Title",
				}),
				createRect({ id: "a-box", bounds: { width: 10, height: 10 } }),
			],
		}),
		properties: withProperty ? [TEXT_PROPERTY] : [],
	};
	const ir = createCanvasIR({ id: "ir-1", pages: [page], now: NOW });
	return { ...ir, components: { "cmp-a": definition } };
}

function definition(ir: CanvasIR): CanvasComponentDefinition {
	const def = ir.components?.["cmp-a"];
	if (!def) throw new Error("missing definition cmp-a");
	return def;
}

function pageNode(ir: CanvasIR, id: string) {
	const root = ir.pages[0]?.root;
	const found = root ? findNodeInSubtree(root, id) : null;
	if (!found) throw new Error(`missing page node ${id}`);
	return found.node;
}

function sourceNode(ir: CanvasIR, id: string) {
	const found = findNodeInSubtree(definition(ir).root, id);
	if (!found) throw new Error(`missing Source node ${id}`);
	return found.node;
}

describe("property commands (M3-06)", () => {
	it("add-property validates the binding and round-trips through remove-property", () => {
		const ir = sampleIR();
		const added = applyCommand(
			ir,
			{
				type: "component.add-property",
				componentId: "cmp-a",
				property: TEXT_PROPERTY,
			},
			{ now: NOW },
		);
		expect(definition(added.ir).properties).toEqual([TEXT_PROPERTY]);
		expect(definition(added.ir).revision).toBe(4);
		expect(added.inverse).toEqual({
			type: "component.remove-property",
			componentId: "cmp-a",
			propertyId: "prop-title",
			revision: 3,
		});
		const undone = applyCommand(added.ir, added.inverse, { now: NOW });
		expect(definition(undone.ir)).toEqual(definition(ir));
	});

	it("rejects duplicate ids, missing targets, and incompatible bindings on write", () => {
		const ir = sampleIR(true);
		expect(() =>
			applyCommand(ir, {
				type: "component.add-property",
				componentId: "cmp-a",
				property: TEXT_PROPERTY,
			}),
		).toThrowError(/already exists/);
		expect(() =>
			applyCommand(ir, {
				type: "component.add-property",
				componentId: "cmp-a",
				property: { ...TEXT_PROPERTY, id: "p2", nodeId: "nope" },
			}),
		).toThrowError(/not in component/);
		// a-box is a rect; a text property cannot bind it (§10.1).
		expect(() =>
			applyCommand(ir, {
				type: "component.add-property",
				componentId: "cmp-a",
				property: { ...TEXT_PROPERTY, id: "p3", nodeId: "a-box" },
			}),
		).toThrowError(/cannot bind/);
	});

	it("update-property renames without changing identity, and pins the id as stable", () => {
		const ir = sampleIR(true);
		const renamed = applyCommand(
			ir,
			{
				type: "component.update-property",
				componentId: "cmp-a",
				propertyId: "prop-title",
				to: { ...TEXT_PROPERTY, name: "Headline" },
			},
			{ now: NOW },
		);
		expect(definition(renamed.ir).properties[0]?.name).toBe("Headline");
		const undone = applyCommand(renamed.ir, renamed.inverse, { now: NOW });
		expect(definition(undone.ir)).toEqual(definition(ir));
		expect(() =>
			applyCommand(ir, {
				type: "component.update-property",
				componentId: "cmp-a",
				propertyId: "prop-title",
				to: { ...TEXT_PROPERTY, id: "prop-renamed" },
			}),
		).toThrowError(/INV-6/);
	});

	it("T-PROP-2: add → override → remove → orphan → restore → re-applies", () => {
		// Add the property, then set an instance override for it.
		let ir = sampleIR(true);
		ir = applyCommand(
			ir,
			{
				type: "component-instance.set-override",
				nodeId: "inst-a",
				propertyId: "prop-title",
				value: { kind: "text", value: { kind: "plain", text: "Hello" } },
			},
			{ now: NOW },
		).ir;
		const overrides = (
			pageNode(ir, "inst-a") as { overrides?: Record<string, unknown> }
		).overrides;

		// While the property exists, the override APPLIES.
		const applied = applyComponentOverrides(definition(ir), overrides);
		const patchedTitle = applied.patches.get("a-title") as CanvasTextNode;
		expect(patchedTitle?.text).toBe("Hello");

		// Remove the property → the override is retained but ORPHANED.
		const removed = applyCommand(
			ir,
			{
				type: "component.remove-property",
				componentId: "cmp-a",
				propertyId: "prop-title",
			},
			{ now: NOW },
		);
		const orphaned = applyComponentOverrides(definition(removed.ir), overrides);
		expect(orphaned.patches.size).toBe(0);
		expect(
			orphaned.issues.some((i) => i.code === "component-override-orphan"),
		).toBe(true);

		// Restore the SAME Property ID compatibly → the override re-applies.
		const restored = applyCommand(removed.ir, removed.inverse, { now: NOW });
		const reapplied = applyComponentOverrides(
			definition(restored.ir),
			overrides,
		);
		expect((reapplied.patches.get("a-title") as CanvasTextNode)?.text).toBe(
			"Hello",
		);
	});
});

describe("locking semantics (M3-13, TD §5.2)", () => {
	function withLockedSourceNode(ir: CanvasIR): CanvasIR {
		return applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "a-title",
				kind: "text",
				patch: { locked: true },
				location: { kind: "component", id: "cmp-a" },
			},
			{ now: NOW },
		).ir;
	}

	it("a locked instance root blocks instance-targeting commands under enforceLocked", () => {
		const ir = sampleIR(true);
		const locked = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "inst-a",
				kind: "component-instance",
				patch: { locked: true },
			},
			{ now: NOW },
		).ir;
		expect(() =>
			applyCommand(
				locked,
				{
					type: "component-instance.set-override",
					nodeId: "inst-a",
					propertyId: "prop-title",
					value: { kind: "text", value: { kind: "plain", text: "x" } },
				},
				{ enforceLocked: true },
			),
		).toThrowError(expect.objectContaining({ code: "node-locked" }));
		expect(() =>
			applyCommand(
				locked,
				{
					type: "node.move",
					nodeId: "inst-a",
					from: { x: 0, y: 0 },
					to: { x: 5, y: 5 },
				},
				{ enforceLocked: true },
			),
		).toThrowError(expect.objectContaining({ code: "node-locked" }));
	});

	it("a locked Source node makes its exposed property read-only in every instance", () => {
		const ir = withLockedSourceNode(sampleIR(true));
		for (const cmd of [
			{
				type: "component-instance.set-override",
				nodeId: "inst-a",
				propertyId: "prop-title",
				value: { kind: "text", value: { kind: "plain", text: "x" } },
			} as const,
		]) {
			expect(() => applyCommand(ir, cmd, { enforceLocked: true })).toThrowError(
				expect.objectContaining({ code: "node-locked" }),
			);
		}
		// reset-one and reset-all of a locked-bound override are blocked too.
		const withOverride = applyCommand(ir, {
			type: "component-instance.set-override",
			nodeId: "inst-a",
			propertyId: "prop-title",
			value: { kind: "text", value: { kind: "plain", text: "x" } },
		}).ir;
		expect(() =>
			applyCommand(
				withOverride,
				{
					type: "component-instance.reset-override",
					nodeId: "inst-a",
					propertyId: "prop-title",
				},
				{ enforceLocked: true },
			),
		).toThrowError(expect.objectContaining({ code: "node-locked" }));
		expect(() =>
			applyCommand(
				withOverride,
				{ type: "component-instance.reset-all-overrides", nodeId: "inst-a" },
				{ enforceLocked: true },
			),
		).toThrowError(expect.objectContaining({ code: "node-locked" }));
	});

	it("a locked Source node blocks Source-scope edits", () => {
		const ir = withLockedSourceNode(sampleIR(true));
		expect(() =>
			applyCommand(
				ir,
				{
					type: "node.update",
					nodeId: "a-title",
					kind: "text",
					patch: { text: "nope" },
					location: { kind: "component", id: "cmp-a" },
				},
				{ enforceLocked: true },
			),
		).toThrowError(expect.objectContaining({ code: "node-locked" }));
	});

	it("the two locks are independent", () => {
		// Source-node lock does NOT block moving the instance itself.
		const sourceLocked = withLockedSourceNode(sampleIR(true));
		const moved = applyCommand(
			sourceLocked,
			{
				type: "node.move",
				nodeId: "inst-a",
				from: { x: 0, y: 0 },
				to: { x: 9, y: 9 },
			},
			{ enforceLocked: true },
		);
		expect(pageNode(moved.ir, "inst-a").transform.x).toBe(9);
		// Instance lock does NOT block editing the Source tree.
		const instanceLocked = applyCommand(
			sampleIR(true),
			{
				type: "node.update",
				nodeId: "inst-a",
				kind: "component-instance",
				patch: { locked: true },
			},
			{ now: NOW },
		).ir;
		const sourceEdited = applyCommand(
			instanceLocked,
			{
				type: "node.update",
				nodeId: "a-title",
				kind: "text",
				patch: { text: "still editable" },
				location: { kind: "component", id: "cmp-a" },
			},
			{ enforceLocked: true, now: NOW },
		);
		expect(
			(sourceNode(sourceEdited.ir, "a-title") as CanvasTextNode).text,
		).toBe("still editable");
	});

	it("an unlocked orphan override is not lock-protected", () => {
		// The orphan's property is gone, so there is no bound node to be locked.
		const ir = withLockedSourceNode(sampleIR(true));
		const removed = applyCommand(
			ir,
			{
				type: "component.remove-property",
				componentId: "cmp-a",
				propertyId: "prop-title",
			},
			{ now: NOW },
		).ir;
		const set = applyCommand(
			removed,
			{
				type: "component-instance.set-override",
				nodeId: "inst-a",
				propertyId: "prop-title",
				value: { kind: "text", value: { kind: "plain", text: "orphan" } },
			},
			{ enforceLocked: true },
		);
		expect(set.ir).not.toBe(removed);
	});
});
