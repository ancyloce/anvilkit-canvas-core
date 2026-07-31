import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
} from "../../ir/types.js";
import {
	compareComponentDefinitions,
	migrateComponentOverrides,
	validateSemanticKeys,
} from "../compatibility.js";

/**
 * T-028 / T-029 — semantic keys, compatibility report, override migration.
 *
 * The matrix that matters is exact / semantic / ambiguous / blocked / orphaned,
 * because those five outcomes are what a user is shown in an update preview and
 * asked to trust before an irreversible-looking change.
 */

function text(
	id: string,
	extra: Partial<CanvasComponentProperty> = {},
): CanvasComponentProperty {
	return {
		id,
		name: id,
		nodeId: `${id}-node`,
		kind: "text",
		targetKind: "text",
		...extra,
	} as CanvasComponentProperty;
}

function color(id: string, semanticKey?: string): CanvasComponentProperty {
	return {
		id,
		name: id,
		nodeId: `${id}-node`,
		kind: "color",
		targetField: "fill",
		...(semanticKey ? { semanticKey } : {}),
	} as CanvasComponentProperty;
}

function def(
	id: string,
	properties: CanvasComponentProperty[],
	extra: Partial<CanvasComponentDefinition> = {},
): CanvasComponentDefinition {
	return {
		id,
		name: id,
		revision: 1,
		root: {
			id: `${id}-root`,
			type: "frame",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			children: [],
		},
		properties,
		...extra,
	} as CanvasComponentDefinition;
}

describe("validateSemanticKeys (T-028)", () => {
	it("accepts a namespaced key", () => {
		expect(
			validateSemanticKeys([text("p1", { semanticKey: "acme.card:title" })]),
		).toEqual([]);
	});

	it.each([
		"Title",
		"title",
		"acme card:title",
		":title",
		"acme:",
		"ACME:Title",
	])("rejects the un-namespaced or malformed key %j", (key) => {
		// An un-namespaced value is indistinguishable from a display label,
		// and migration keyed on a localized label would behave differently
		// per authoring language.
		const issues = validateSemanticKeys([text("p1", { semanticKey: key })]);
		expect(issues.map((i) => i.code)).toContain("semantic-key-malformed");
	});

	it("rejects two properties of the SAME KIND sharing a key", () => {
		const issues = validateSemanticKeys([
			text("p1", { semanticKey: "acme:title" }),
			text("p2", { semanticKey: "acme:title" }),
		]);
		expect(issues.map((i) => i.code)).toContain("semantic-key-duplicate");
	});

	it("ALLOWS two properties of different kinds to share a key", () => {
		// A text and a color property may legitimately describe the same slot in
		// different media; migration matches on (key, kind) anyway.
		expect(
			validateSemanticKeys([
				text("p1", { semanticKey: "acme:hero" }),
				color("p2", "acme:hero"),
			]),
		).toEqual([]);
	});

	it("ignores properties with no semantic key", () => {
		expect(validateSemanticKeys([text("p1"), text("p2")])).toEqual([]);
	});
});

describe("compareComponentDefinitions — the five-outcome matrix (T-029)", () => {
	it("EXACT: same id, same kind", () => {
		const report = compareComponentDefinitions(
			def("a", [text("title")]),
			def("b", [text("title")]),
		);
		expect(report.properties).toEqual([
			{ fromPropertyId: "title", toPropertyId: "title", kind: "exact" },
		]);
		expect(report.classification).toBe("compatible");
	});

	it("SEMANTIC: different id, same semantic key and kind", () => {
		const report = compareComponentDefinitions(
			def("a", [text("p-old", { semanticKey: "acme:title" })]),
			def("b", [text("p-new", { semanticKey: "acme:title" })]),
		);
		expect(report.properties[0]).toMatchObject({
			fromPropertyId: "p-old",
			toPropertyId: "p-new",
			kind: "semantic",
		});
	});

	it("AMBIGUOUS: a semantic key claimed by two target properties", () => {
		// Refusing to guess is the point — picking one would corrupt a document
		// silently, and the user has no way to tell which.
		const report = compareComponentDefinitions(
			def("a", [text("p-old", { semanticKey: "acme:title" })]),
			def("b", [
				text("p-1", { semanticKey: "acme:title" }),
				text("p-2", { semanticKey: "acme:title" }),
			]),
		);
		expect(report.properties[0]?.kind).toBe("ambiguous");
		expect(report.properties[0]?.toPropertyId).toBeUndefined();
		expect(report.classification).toBe("review-required");
	});

	it("BLOCKED: same id, different kind", () => {
		const report = compareComponentDefinitions(
			def("a", [text("slot")]),
			def("b", [color("slot")]),
		);
		expect(report.properties[0]?.kind).toBe("blocked");
		expect(report.classification).toBe("incompatible");
	});

	it("ORPHANED: no counterpart at all", () => {
		const report = compareComponentDefinitions(
			def("a", [text("gone")]),
			def("b", [text("other")]),
		);
		expect(report.properties[0]?.kind).toBe("orphaned");
		expect(report.classification).toBe("review-required");
	});

	it("does NOT match on display name", () => {
		// Same `name`, different id, no semantic key => orphaned, not matched.
		const report = compareComponentDefinitions(
			def("a", [
				{ ...text("p-old"), name: "Title" } as CanvasComponentProperty,
			]),
			def("b", [
				{ ...text("p-new"), name: "Title" } as CanvasComponentProperty,
			]),
		);
		expect(report.properties[0]?.kind).toBe("orphaned");
	});

	it("prefers an EXACT id match over a semantic one", () => {
		const report = compareComponentDefinitions(
			def("a", [text("shared", { semanticKey: "acme:title" })]),
			def("b", [
				text("shared", { semanticKey: "acme:other" }),
				text("elsewhere", { semanticKey: "acme:title" }),
			]),
		);
		expect(report.properties[0]).toMatchObject({
			toPropertyId: "shared",
			kind: "exact",
		});
	});

	it("reports added target properties", () => {
		const report = compareComponentDefinitions(
			def("a", [text("keep")]),
			def("b", [text("keep"), text("brand-new")]),
		);
		expect(report.addedPropertyIds).toEqual(["brand-new"]);
	});

	it("classification is the WORST outcome present", () => {
		const report = compareComponentDefinitions(
			def("a", [text("keep"), text("slot")]),
			def("b", [text("keep"), color("slot")]),
		);
		// One exact match does not make an incompatible change compatible.
		expect(report.classification).toBe("incompatible");
	});

	it("is deterministic and sorted", () => {
		const from = def("a", [text("z"), text("a"), text("m")]);
		const to = def("b", [text("a")]);
		const first = compareComponentDefinitions(from, to);
		const second = compareComponentDefinitions(from, to);
		expect(first).toEqual(second);
		expect(first.properties.map((p) => p.fromPropertyId)).toEqual([
			"a",
			"m",
			"z",
		]);
	});
});

describe("compareComponentDefinitions — variants and dependencies", () => {
	const variantSet = (axisId: string, values: string[]) => ({
		axes: [
			{
				id: axisId,
				values: values.map((id) => ({ id })),
				defaultValueId: values[0] as string,
			},
		],
		variants: [{ id: "v", selection: { [axisId]: values[0] as string } }],
		defaultVariantId: "v",
	});

	it("matches axes by ID, and reports a dropped axis", () => {
		const report = compareComponentDefinitions(
			def("a", [], { variants: variantSet("size", ["sm", "lg"]) }),
			def("b", [], { variants: variantSet("tone", ["brand"]) }),
		);
		expect(report.variants).toEqual([
			{ axisId: "size", retained: false, droppedValueIds: ["lg", "sm"] },
		]);
		expect(report.classification).toBe("review-required");
	});

	it("reports values dropped from a retained axis", () => {
		const report = compareComponentDefinitions(
			def("a", [], { variants: variantSet("size", ["sm", "lg"]) }),
			def("b", [], { variants: variantSet("size", ["sm"]) }),
		);
		expect(report.variants[0]).toEqual({
			axisId: "size",
			retained: true,
			droppedValueIds: ["lg"],
		});
	});

	it("is compatible when the axis is unchanged", () => {
		const report = compareComponentDefinitions(
			def("a", [], { variants: variantSet("size", ["sm"]) }),
			def("b", [], { variants: variantSet("size", ["sm"]) }),
		);
		expect(report.variants[0]?.droppedValueIds).toEqual([]);
		expect(report.classification).toBe("compatible");
	});

	it("reports added and removed nested dependencies", () => {
		const withChild = (childId: string) =>
			def("a", [], {
				root: {
					id: "root",
					type: "frame",
					transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
					bounds: { width: 1, height: 1 },
					zIndex: 0,
					children: [
						{
							id: "nested",
							type: "component-instance",
							transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
							bounds: { width: 1, height: 1 },
							zIndex: 0,
							source: { kind: "local", componentId: childId },
						},
					],
				},
			} as Partial<CanvasComponentDefinition>);

		const report = compareComponentDefinitions(
			withChild("old"),
			withChild("new"),
		);
		expect(report.dependencies).toEqual([
			{ componentId: "new", change: "added" },
			{ componentId: "old", change: "removed" },
		]);
	});
});

describe("migrateComponentOverrides (§12.4)", () => {
	const overrides: CanvasComponentOverrideMap = {
		title: { kind: "text", value: { kind: "plain", text: "Hello" } },
		badge: { kind: "visibility", visible: false },
	};

	it("carries an exact match onto the same id", () => {
		const report = compareComponentDefinitions(
			def("a", [text("title")]),
			def("b", [text("title")]),
		);
		const result = migrateComponentOverrides(
			{ title: overrides.title },
			report,
		);
		expect(result.overrides.title).toEqual(overrides.title);
		expect(result.orphaned).toEqual({});
	});

	it("carries a semantic match onto the NEW id", () => {
		const report = compareComponentDefinitions(
			def("a", [text("p-old", { semanticKey: "acme:title" })]),
			def("b", [text("p-new", { semanticKey: "acme:title" })]),
		);
		const result = migrateComponentOverrides(
			{ "p-old": overrides.title },
			report,
		);
		expect(result.overrides["p-new"]).toEqual(overrides.title);
		expect(result.overrides["p-old"]).toBeUndefined();
	});

	it.each([
		"ambiguous",
		"blocked",
		"orphaned",
	] as const)("RETAINS a %s override rather than dropping it", (kind) => {
		const report = {
			classification: "review-required" as const,
			properties: [{ fromPropertyId: "title", kind }],
			variants: [],
			dependencies: [],
			addedPropertyIds: [],
		};
		const result = migrateComponentOverrides(
			{ title: overrides.title },
			report,
		);
		// The data survives, so an undo or a swap-back returns it (INV-6).
		expect(result.orphaned.title).toEqual(overrides.title);
		expect(result.overrides).toEqual({});
	});

	it("never invents a value for an added target property", () => {
		const report = compareComponentDefinitions(
			def("a", [text("title")]),
			def("b", [text("title"), text("subtitle")]),
		);
		const result = migrateComponentOverrides(
			{ title: overrides.title },
			report,
		);
		expect(result.overrides.subtitle).toBeUndefined();
		expect(Object.keys(result.overrides)).toEqual(["title"]);
	});

	it("handles an absent override map", () => {
		const report = compareComponentDefinitions(def("a", []), def("b", []));
		const result = migrateComponentOverrides(undefined, report);
		expect(result.overrides).toEqual({});
		expect(result.orphaned).toEqual({});
	});

	it("PROP: every input override appears exactly once in output or orphans", () => {
		// "Migration never invents a value" and "migration never loses one",
		// as one conservation law.
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
					minLength: 1,
					maxLength: 6,
				}),
				fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
					maxLength: 6,
				}),
				(fromIds, toIds) => {
					const report = compareComponentDefinitions(
						def(
							"a",
							fromIds.map((id) => text(id)),
						),
						def(
							"b",
							toIds.map((id) => text(id)),
						),
					);
					const input: Record<string, CanvasComponentOverrideMap[string]> = {};
					for (const id of fromIds) {
						input[id] = { kind: "visibility", visible: true };
					}
					const result = migrateComponentOverrides(input, report);
					const total =
						Object.keys(result.overrides).length +
						Object.keys(result.orphaned).length;
					return total === fromIds.length;
				},
			),
		);
	});
});
