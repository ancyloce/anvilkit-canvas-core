/**
 * plan 0023 M3-02 (T-CMD-2): registry commands (create/rename/duplicate/
 * delete) and instance commands (insert/set-override/reset-override/
 * reset-all-overrides) are validated, invertible, atomic built-ins.
 * command → inverse → original round-trips byte-identically — registry
 * commands restore even `revision` via the explicit-revision convention.
 */

import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createGroup,
	createPage,
	createRect,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasComponentOverride,
	CanvasIR,
} from "../../ir/types.js";
import { findNodeInSubtree, walkDocument } from "../../ir/walkers.js";
import { commandToChange } from "../change-events.js";
import { applyCommand } from "../runtime.js";

const NOW = () => "2026-07-29T00:00:00.000Z";

function makeDefinition(
	id: string,
	rootId: string,
	children: CanvasComponentDefinition["root"][] = [],
): CanvasComponentDefinition {
	return {
		id,
		name: `Def ${id}`,
		revision: 3,
		root: createFrame({
			id: rootId,
			bounds: { width: 100, height: 80 },
			children: [
				createRect({
					id: `${rootId}-rect`,
					bounds: { width: 10, height: 10 },
				}),
				...children,
			],
		}),
		properties: [
			{
				id: "prop-vis",
				name: "Visible",
				nodeId: `${rootId}-rect`,
				kind: "visibility",
			},
		],
	};
}

function sampleIR(): CanvasIR {
	const page = createPage({ id: "p1" });
	page.root = createGroup({
		id: "pg-root",
		bounds: page.root.bounds,
		children: [
			createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
			createComponentInstance({
				id: "inst-a",
				componentId: "cmp-a",
				bounds: { width: 100, height: 80 },
			}),
		],
	});
	// cmp-a nests an instance of cmp-b inside its Source tree.
	const defA = makeDefinition("cmp-a", "a-root", [
		createComponentInstance({
			id: "nested-b",
			componentId: "cmp-b",
			bounds: { width: 20, height: 20 },
		}),
	]);
	const defB = makeDefinition("cmp-b", "b-root");
	const ir = createCanvasIR({ id: "ir-1", pages: [page], now: NOW });
	return { ...ir, components: { "cmp-a": defA, "cmp-b": defB } };
}

function definition(ir: CanvasIR, id: string): CanvasComponentDefinition {
	const def = ir.components?.[id];
	if (!def) throw new Error(`missing definition ${id}`);
	return def;
}

function pageInstance(ir: CanvasIR, id: string): CanvasComponentInstanceNode {
	const root = ir.pages[0]?.root;
	const found = root ? findNodeInSubtree(root, id) : null;
	if (!found || found.node.type !== "component-instance") {
		throw new Error(`missing instance ${id}`);
	}
	return found.node;
}

const OVERRIDE: CanvasComponentOverride = {
	kind: "visibility",
	visible: false,
};

describe("component.create (restore) / component.delete", () => {
	it("restore adds the definition; its inverse removes it exactly", () => {
		const ir = sampleIR();
		const defC = makeDefinition("cmp-c", "c-root");
		const created = applyCommand(
			ir,
			{ type: "component.create", mode: "restore", definition: defC },
			{ now: NOW },
		);
		expect(definition(created.ir, "cmp-c")).toBe(defC);
		const undone = applyCommand(created.ir, created.inverse, { now: NOW });
		expect(undone.ir.components).toEqual(ir.components);
	});

	it("rejects a duplicate component id, colliding Source node ids (INV-2), and self-cycles", () => {
		const ir = sampleIR();
		expect(() =>
			applyCommand(ir, {
				type: "component.create",
				mode: "restore",
				definition: makeDefinition("cmp-a", "other-root"),
			}),
		).toThrowError(/already exists/);
		// b-root already lives in cmp-b's Source tree.
		expect(() =>
			applyCommand(ir, {
				type: "component.create",
				mode: "restore",
				definition: makeDefinition("cmp-c", "b-root"),
			}),
		).toThrowError(/INV-2/);
		const selfCycle = makeDefinition("cmp-self", "self-root", [
			createComponentInstance({
				id: "self-ref",
				componentId: "cmp-self",
				bounds: { width: 5, height: 5 },
			}),
		]);
		expect(() =>
			applyCommand(ir, {
				type: "component.create",
				mode: "restore",
				definition: selfCycle,
			}),
		).toThrowError(/cycle/);
	});

	it("delete requires zero references and reports the live ones", () => {
		const ir = sampleIR();
		// cmp-a is referenced by a page instance; cmp-b by cmp-a's Source tree.
		expect(() =>
			applyCommand(ir, { type: "component.delete", componentId: "cmp-a" }),
		).toThrowError(/1 reference\(s\) \(page:p1\)/);
		expect(() =>
			applyCommand(ir, { type: "component.delete", componentId: "cmp-b" }),
		).toThrowError(/component:cmp-a/);
	});

	it("deleting the last definition drops the components key; undo restores key AND contents (INV-10)", () => {
		const page = createPage({ id: "p1" });
		const defOnly = makeDefinition("cmp-solo", "solo-root");
		const base = createCanvasIR({ id: "ir-2", pages: [page], now: NOW });
		const ir: CanvasIR = { ...base, components: { "cmp-solo": defOnly } };
		const deleted = applyCommand(
			ir,
			{ type: "component.delete", componentId: "cmp-solo" },
			{ now: NOW },
		);
		expect("components" in deleted.ir).toBe(false);
		const restored = applyCommand(deleted.ir, deleted.inverse, { now: NOW });
		expect(restored.ir.components).toEqual(ir.components);
	});
});

describe("component.rename", () => {
	it("renames, bumps revision once, and the inverse restores name AND revision exactly", () => {
		const ir = sampleIR();
		const renamed = applyCommand(
			ir,
			{ type: "component.rename", componentId: "cmp-a", to: "Hero Card" },
			{ now: NOW },
		);
		expect(definition(renamed.ir, "cmp-a").name).toBe("Hero Card");
		// Handler-managed: exactly +1, and the settle pass must not double-bump.
		expect(definition(renamed.ir, "cmp-a").revision).toBe(4);
		const undone = applyCommand(renamed.ir, renamed.inverse, { now: NOW });
		expect(definition(undone.ir, "cmp-a")).toEqual(definition(ir, "cmp-a"));
	});
});

describe("component.duplicate", () => {
	it("copies under the new id with remapped Source node ids and followed property bindings", () => {
		const ir = sampleIR();
		const duplicated = applyCommand(
			ir,
			{
				type: "component.duplicate",
				componentId: "cmp-b",
				newComponentId: "cmp-b2",
			},
			{ now: NOW },
		);
		const copy = definition(duplicated.ir, "cmp-b2");
		expect(copy.name).toBe("Def cmp-b copy");
		expect(copy.revision).toBe(1);
		// Every node id was remapped (INV-2): none may repeat anywhere.
		const seen = new Map<string, number>();
		walkDocument(duplicated.ir, ({ node }) => {
			seen.set(node.id, (seen.get(node.id) ?? 0) + 1);
		});
		for (const [id, count] of seen) {
			expect(count, `node id "${id}" appears ${count} times`).toBe(1);
		}
		// The property follows its remapped target and keeps its Property ID.
		const prop = copy.properties[0];
		expect(prop?.id).toBe("prop-vis");
		expect(prop?.nodeId).not.toBe("b-root-rect");
		expect(findNodeInSubtree(copy.root, prop?.nodeId ?? "")).not.toBeNull();
		// The original is untouched, reference-identically.
		expect(definition(duplicated.ir, "cmp-b")).toBe(definition(ir, "cmp-b"));
		// Inverse removes the copy.
		const undone = applyCommand(duplicated.ir, duplicated.inverse, {
			now: NOW,
		});
		expect(undone.ir.components).toEqual(ir.components);
	});
});

describe("component-instance.insert", () => {
	it("inserts a validated instance and round-trips through node.delete", () => {
		const ir = sampleIR();
		const inserted = applyCommand(
			ir,
			{
				type: "component-instance.insert",
				componentId: "cmp-b",
				instanceId: "inst-b",
				pageId: "p1",
				bounds: { width: 50, height: 40 },
				overrides: { "prop-vis": OVERRIDE },
			},
			{ now: NOW },
		);
		const node = pageInstance(inserted.ir, "inst-b");
		expect(node.componentId).toBe("cmp-b");
		expect(node.overrides).toEqual({ "prop-vis": OVERRIDE });
		expect(inserted.inverse).toEqual({ type: "node.delete", nodeId: "inst-b" });
		const undone = applyCommand(inserted.ir, inserted.inverse, { now: NOW });
		expect(undone.ir.pages).toEqual(ir.pages);
	});

	it("rejects an unknown componentId instead of creating a broken reference", () => {
		const ir = sampleIR();
		expect(() =>
			applyCommand(ir, {
				type: "component-instance.insert",
				componentId: "cmp-nope",
				instanceId: "inst-x",
				pageId: "p1",
				bounds: { width: 1, height: 1 },
			}),
		).toThrowError(expect.objectContaining({ code: "location-not-found" }));
	});
});

describe("override commands", () => {
	it("set → reset round-trips, normalizing an emptied map to an absent key", () => {
		const ir = sampleIR();
		const set = applyCommand(
			ir,
			{
				type: "component-instance.set-override",
				nodeId: "inst-a",
				propertyId: "prop-vis",
				value: OVERRIDE,
			},
			{ now: NOW },
		);
		expect(pageInstance(set.ir, "inst-a").overrides).toEqual({
			"prop-vis": OVERRIDE,
		});
		// New entry → the inverse is a reset.
		expect(set.inverse.type).toBe("component-instance.reset-override");
		const undone = applyCommand(set.ir, set.inverse, { now: NOW });
		expect("overrides" in pageInstance(undone.ir, "inst-a")).toBe(false);
		expect(undone.ir.pages).toEqual(ir.pages);
	});

	it("overwriting an entry inverts to the prior value", () => {
		const ir = sampleIR();
		const first = applyCommand(
			ir,
			{
				type: "component-instance.set-override",
				nodeId: "inst-a",
				propertyId: "prop-vis",
				value: OVERRIDE,
			},
			{ now: NOW },
		);
		const second = applyCommand(
			first.ir,
			{
				type: "component-instance.set-override",
				nodeId: "inst-a",
				propertyId: "prop-vis",
				value: { kind: "visibility", visible: true },
			},
			{ now: NOW },
		);
		expect(second.inverse).toEqual({
			type: "component-instance.set-override",
			nodeId: "inst-a",
			propertyId: "prop-vis",
			value: OVERRIDE,
		});
		const undone = applyCommand(second.ir, second.inverse, { now: NOW });
		expect(pageInstance(undone.ir, "inst-a").overrides).toEqual({
			"prop-vis": OVERRIDE,
		});
	});

	it("reset-all restores the exact prior map on undo; absent maps are validated no-ops", () => {
		const ir = sampleIR();
		const withTwo = applyCommand(
			applyCommand(
				ir,
				{
					type: "component-instance.set-override",
					nodeId: "inst-a",
					propertyId: "prop-vis",
					value: OVERRIDE,
				},
				{ now: NOW },
			).ir,
			{
				type: "component-instance.set-override",
				nodeId: "inst-a",
				propertyId: "prop-txt",
				value: { kind: "text", value: { kind: "plain", text: "hi" } },
			},
			{ now: NOW },
		).ir;
		const cleared = applyCommand(
			withTwo,
			{ type: "component-instance.reset-all-overrides", nodeId: "inst-a" },
			{ now: NOW },
		);
		expect("overrides" in pageInstance(cleared.ir, "inst-a")).toBe(false);
		const undone = applyCommand(cleared.ir, cleared.inverse, { now: NOW });
		expect(pageInstance(undone.ir, "inst-a").overrides).toEqual(
			pageInstance(withTwo, "inst-a").overrides,
		);

		// No-op paths: same ir back, inverse is the command itself.
		const noopReset = applyCommand(ir, {
			type: "component-instance.reset-override",
			nodeId: "inst-a",
			propertyId: "prop-vis",
		});
		expect(noopReset.ir).toBe(ir);
		const noopAll = applyCommand(ir, {
			type: "component-instance.reset-all-overrides",
			nodeId: "inst-a",
		});
		expect(noopAll.ir).toBe(ir);
	});

	it("enforces the per-instance override cap", () => {
		const ir = sampleIR();
		const full: Record<string, CanvasComponentOverride> = {};
		for (let i = 0; i < 128; i++) {
			full[`p${i}`] = OVERRIDE;
		}
		const packed = applyCommand(
			ir,
			{
				type: "node.update",
				nodeId: "inst-a",
				kind: "component-instance",
				patch: { overrides: full },
			},
			{ now: NOW },
		).ir;
		expect(() =>
			applyCommand(packed, {
				type: "component-instance.set-override",
				nodeId: "inst-a",
				propertyId: "p-one-more",
				value: OVERRIDE,
			}),
		).toThrowError(/MAX_COMPONENT_OVERRIDES_PER_INSTANCE/);
	});

	it("targets must be instances", () => {
		const ir = sampleIR();
		expect(() =>
			applyCommand(ir, {
				type: "component-instance.set-override",
				nodeId: "r1",
				propertyId: "p",
				value: OVERRIDE,
			}),
		).toThrowError(expect.objectContaining({ code: "kind-mismatch" }));
	});
});

describe("settle + change-event interplay", () => {
	it("an override edit on a NESTED instance inside a Source tree bumps the HOST revision once", () => {
		const ir = sampleIR();
		const next = applyCommand(
			ir,
			{
				type: "component-instance.set-override",
				nodeId: "nested-b",
				propertyId: "prop-vis",
				value: OVERRIDE,
				location: { kind: "component", id: "cmp-a" },
			},
			{ now: NOW },
		);
		expect(definition(next.ir, "cmp-a").revision).toBe(4);
		expect(definition(next.ir, "cmp-b")).toBe(definition(ir, "cmp-b"));
	});

	it("maps registry and instance commands to their change records", () => {
		expect(
			commandToChange({
				type: "component.rename",
				componentId: "cmp-a",
				to: "X",
				revision: 7,
			}),
		).toEqual({
			kind: "component",
			componentId: "cmp-a",
			op: "rename",
			revision: 7,
		});
		expect(
			commandToChange({ type: "component.delete", componentId: "cmp-a" }),
		).toEqual({ kind: "component", componentId: "cmp-a", op: "delete" });
		expect(
			commandToChange({
				type: "component.duplicate",
				componentId: "cmp-a",
				newComponentId: "cmp-a2",
			}),
		).toEqual({ kind: "component", componentId: "cmp-a2", op: "duplicate" });
		expect(
			commandToChange({
				type: "component-instance.insert",
				componentId: "cmp-a",
				instanceId: "i1",
				pageId: "p1",
				bounds: { width: 1, height: 1 },
			}),
		).toEqual({ kind: "added", nodeId: "i1", pageId: "p1" });
		expect(
			commandToChange({
				type: "component-instance.set-override",
				nodeId: "i1",
				propertyId: "p",
				value: OVERRIDE,
			}),
		).toEqual({ kind: "updated", nodeId: "i1", keys: ["overrides"] });
		// In a Source tree, the same instance edit is a component source-edit.
		expect(
			commandToChange({
				type: "component-instance.set-override",
				nodeId: "nested-b",
				propertyId: "p",
				value: OVERRIDE,
				location: { kind: "component", id: "cmp-a" },
			}),
		).toEqual({ kind: "component", componentId: "cmp-a", op: "source-edit" });
	});
});
