import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createComponentInstance,
	createGroup,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import { MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION } from "../../limits.js";
import {
	assertComponentGraph,
	CanvasComponentGraphError,
	validateComponentGraph,
} from "../validate.js";

/**
 * T-DIAG-1 (plan 0023 M2-09): the reporting/strict pair mirrors the shipped
 * invariant trio — warnings NEVER throw, errors carry the full issue list,
 * and issue order is deterministic. Each statically-checkable code has a
 * firing fixture here; `component-materialization-stale`,
 * `component-detach-incomplete`, and `component-capability-unsupported` are
 * emitted by their owning M3/M6 flows.
 */

const NOW = () => "2026-07-29T00:00:00.000Z";

function def(
	id: string,
	root: CanvasNode,
	properties: CanvasComponentDefinition["properties"] = [],
): CanvasComponentDefinition {
	return { id, name: id, revision: 0, root, properties };
}

function docWith(
	components: Record<string, CanvasComponentDefinition>,
	pageChildren: CanvasNode[] = [],
): CanvasIR {
	let ir = createCanvasIR({ id: "doc", now: NOW });
	for (const child of pageChildren) {
		ir = insertNode(ir, {
			parentId: ir.pages[0]?.root.id as string,
			node: child,
			now: NOW,
		});
	}
	return { ...ir, components };
}

describe("validateComponentGraph (T-DIAG-1)", () => {
	it("a clean component document reports nothing and assert passes", () => {
		const doc = docWith(
			{
				"cmp-ok": def(
					"cmp-ok",
					createRect({ id: "ok-root", bounds: { width: 5, height: 5 } }),
				),
			},
			[
				createComponentInstance({
					id: "inst-ok",
					bounds: { width: 5, height: 5 },
					componentId: "cmp-ok",
				}),
			],
		);
		expect(validateComponentGraph(doc)).toEqual([]);
		expect(() => assertComponentGraph(doc)).not.toThrow();
	});

	it("emits every statically-checkable error code with deterministic order", () => {
		const cycleA = def(
			"cmp-a",
			createGroup({
				id: "a-root",
				children: [
					createComponentInstance({
						id: "a-to-b",
						bounds: { width: 5, height: 5 },
						componentId: "cmp-b",
					}),
				],
			}),
		);
		const cycleB = def(
			"cmp-b",
			createGroup({
				id: "b-root",
				children: [
					createComponentInstance({
						id: "b-to-a",
						bounds: { width: 5, height: 5 },
						componentId: "cmp-a",
					}),
				],
			}),
		);
		const broken = def(
			"cmp-broken",
			createRect({ id: "shared-id", bounds: { width: 5, height: 5 } }),
			[
				{
					id: "p-gone",
					name: "Gone",
					nodeId: "nowhere",
					kind: "visibility",
				},
				{
					id: "p-wrong",
					name: "Wrong",
					nodeId: "shared-id",
					kind: "text",
					targetKind: "text",
				},
			],
		);

		const doc = docWith(
			{ "cmp-a": cycleA, "cmp-b": cycleB, "cmp-broken": broken },
			[
				// duplicate of the definition node id, on a page
				createRect({ id: "shared-id", bounds: { width: 5, height: 5 } }),
				// reference to a component that does not exist
				createComponentInstance({
					id: "inst-ghost",
					bounds: { width: 5, height: 5 },
					componentId: "cmp-ghost",
				}),
			],
		);

		const issues = validateComponentGraph(doc);
		expect(issues.map((i) => i.code)).toEqual([
			"component-cycle",
			"component-property-target-missing",
			"component-property-type-invalid",
			"component-duplicate-id",
			"component-source-missing",
		]);
		expect(issues.every((i) => i.severity === "error")).toBe(true);

		// Determinism: a second run is byte-identical.
		expect(validateComponentGraph(doc)).toEqual(issues);

		expect(() => assertComponentGraph(doc)).toThrow(CanvasComponentGraphError);
		try {
			assertComponentGraph(doc);
		} catch (error) {
			expect((error as CanvasComponentGraphError).issues).toEqual(issues);
		}
	});

	it("warnings (orphan + type-invalid overrides) never throw", () => {
		const doc = docWith(
			{
				"cmp-w": def(
					"cmp-w",
					createRect({ id: "w-root", bounds: { width: 5, height: 5 } }),
					[
						{
							id: "p-show",
							name: "Show",
							nodeId: "w-root",
							kind: "visibility",
						},
					],
				),
			},
			[
				createComponentInstance({
					id: "inst-w",
					bounds: { width: 5, height: 5 },
					componentId: "cmp-w",
					overrides: {
						"p-ghost": { kind: "visibility", visible: true },
						"p-show": { kind: "color", value: "#ff0000" },
					},
				}),
			],
		);
		const issues = validateComponentGraph(doc);
		expect(issues.map((i) => [i.code, i.severity])).toEqual([
			["component-override-orphan", "warning"],
			["component-override-type-invalid", "warning"],
		]);
		expect(() => assertComponentGraph(doc)).not.toThrow();
	});

	it("flags a predictable expansion-budget blowout", () => {
		// 40 children per definition ×
		// ceil(cap / 40) + 1 instances ⇒ predictably over the cap.
		const wide = def(
			"cmp-wide",
			createGroup({
				id: "wide-root",
				children: Array.from({ length: 39 }, (_, i) =>
					createRect({ id: `wide-${i}`, bounds: { width: 1, height: 1 } }),
				),
			}),
		);
		const instanceCount =
			Math.ceil(MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION / 40) + 1;
		const doc = docWith(
			{ "cmp-wide": wide },
			Array.from({ length: instanceCount }, (_, i) =>
				createComponentInstance({
					id: `inst-${i}`,
					bounds: { width: 1, height: 1 },
					componentId: "cmp-wide",
				}),
			),
		);
		const issues = validateComponentGraph(doc);
		expect(issues.some((i) => i.code === "component-expanded-node-limit")).toBe(
			true,
		);
	});

	it("flags a chain past the nested-depth cap", () => {
		const registry: Record<string, CanvasComponentDefinition> = {};
		for (let i = 0; i < 18; i += 1) {
			const id = `cmp-${String(i).padStart(2, "0")}`;
			const children: CanvasNode[] =
				i < 17
					? [
							createComponentInstance({
								id: `${id}-next`,
								bounds: { width: 1, height: 1 },
								componentId: `cmp-${String(i + 1).padStart(2, "0")}`,
							}),
						]
					: [createRect({ id: `${id}-leaf`, bounds: { width: 1, height: 1 } })];
			registry[id] = def(id, createGroup({ id: `${id}-root`, children }));
		}
		const issues = validateComponentGraph(docWith(registry));
		expect(
			issues.filter((i) => i.code === "component-depth-exceeded").length,
		).toBeGreaterThan(0);
	});
});
