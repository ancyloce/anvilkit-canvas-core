import { describe, expect, it } from "vitest";

import { CanvasCommandError } from "../../commands/runtime.js";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import { createCanvasIR, createComponentInstance } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasComponentOverrideMap,
	CanvasIR,
} from "../../ir/types.js";
import { findNode } from "../../ir/walkers.js";
import {
	createSetVariantCommandHandlers,
	previewVariantChange,
	SET_VARIANT_COMMAND,
} from "../commands/set-variant.js";

/**
 * T-026 — one variant change, one Undo entry, orphans retained.
 */

const AT = { now: () => "t0" } as const;

function runtime() {
	return createCanvasRuntime([
		{
			id: "plan-0021-variants",
			commands: [...createSetVariantCommandHandlers()],
		},
	]);
}

function definition(): CanvasComponentDefinition {
	return {
		id: "cmp-card",
		name: "Card",
		revision: 1,
		root: {
			id: "card-root",
			type: "frame",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 50 },
			zIndex: 0,
			children: [],
		},
		properties: [
			{
				id: "p-title",
				name: "Title",
				nodeId: "n-title",
				kind: "text",
				targetKind: "text",
			},
			{ id: "p-badge", name: "Badge", nodeId: "n-badge", kind: "visibility" },
		],
		variants: {
			axes: [
				{
					id: "size",
					values: [{ id: "sm" }, { id: "lg" }],
					defaultValueId: "sm",
				},
			],
			variants: [
				{ id: "v-sm", selection: { size: "sm" } },
				{
					id: "v-lg",
					selection: { size: "lg" },
					// `lg` unbinds the badge — the case that orphans an override.
					propertyTargetMap: { "p-badge": "" },
				},
			],
			defaultVariantId: "v-sm",
		},
	} as CanvasComponentDefinition;
}

const OVERRIDES: CanvasComponentOverrideMap = {
	"p-title": { kind: "text", value: { kind: "plain", text: "Hello" } },
	"p-badge": { kind: "visibility", visible: false },
};

function doc(
	options: {
		overrides?: CanvasComponentOverrideMap;
		withVariants?: boolean;
	} = {},
): CanvasIR {
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	const def = definition();
	const withRegistry: CanvasIR = {
		...base,
		components: {
			"cmp-card":
				options.withVariants === false
					? ({ ...def, variants: undefined } as CanvasComponentDefinition)
					: def,
		},
	};
	return insertNode(withRegistry, {
		parentId: withRegistry.pages[0]?.root.id as string,
		node: createComponentInstance({
			id: "inst-1",
			componentId: "cmp-card",
			bounds: { width: 100, height: 50 },
			...(options.overrides ? { overrides: options.overrides } : {}),
		}),
		now: () => "t0",
	});
}

function instanceOf(ir: CanvasIR): CanvasComponentInstanceNode {
	return findNode(ir, "inst-1")?.node as CanvasComponentInstanceNode;
}

describe("component-instance.set-variant (T-026)", () => {
	it("stores the selection the user CHOSE, not the normalized one", () => {
		// Normalizing on write would freeze today's axis defaults into the
		// document, so a later change to a default would never reach it.
		const { ir } = runtime().apply(
			doc(),
			{
				type: SET_VARIANT_COMMAND,
				instanceId: "inst-1",
				selection: { size: "lg" },
			},
			AT,
		);
		expect(instanceOf(ir).variantSelection).toEqual({ size: "lg" });
	});

	it("is exactly ONE history entry per change", () => {
		const rt = runtime();
		const result = rt.apply(
			doc(),
			{
				type: SET_VARIANT_COMMAND,
				instanceId: "inst-1",
				selection: { size: "lg" },
			},
			AT,
		);
		expect(result.inverse).toBeTruthy();
		expect(
			Array.isArray((result.inverse as { commands?: unknown }).commands),
		).toBe(false);
	});

	it("RETAINS an override the target variant unbinds (default behaviour)", () => {
		const { ir } = runtime().apply(
			doc({ overrides: OVERRIDES }),
			{
				type: SET_VARIANT_COMMAND,
				instanceId: "inst-1",
				selection: { size: "lg" },
			},
			AT,
		);
		// `p-badge` is unbound by v-lg but the data survives — switching back
		// must return it.
		expect(instanceOf(ir).overrides).toEqual(OVERRIDES);
	});

	it("discards orphans only when explicitly asked", () => {
		const { ir } = runtime().apply(
			doc({ overrides: OVERRIDES }),
			{
				type: SET_VARIANT_COMMAND,
				instanceId: "inst-1",
				selection: { size: "lg" },
				discardOrphans: true,
			},
			AT,
		);
		expect(Object.keys(instanceOf(ir).overrides ?? {})).toEqual(["p-title"]);
	});

	describe("inverse", () => {
		it("restores the prior selection and overrides exactly", () => {
			const rt = runtime();
			const before = doc({ overrides: OVERRIDES });
			const { ir, inverse } = rt.apply(
				before,
				{
					type: SET_VARIANT_COMMAND,
					instanceId: "inst-1",
					selection: { size: "lg" },
				},
				AT,
			);
			expect(rt.apply(ir, inverse, AT).ir).toEqual(before);
		});

		it("restores DISCARDED overrides — undo returns the data", () => {
			const rt = runtime();
			const before = doc({ overrides: OVERRIDES });
			const { ir, inverse } = rt.apply(
				before,
				{
					type: SET_VARIANT_COMMAND,
					instanceId: "inst-1",
					selection: { size: "lg" },
					discardOrphans: true,
				},
				AT,
			);
			expect(Object.keys(instanceOf(ir).overrides ?? {})).toEqual(["p-title"]);
			const undone = rt.apply(ir, inverse, AT).ir;
			expect(instanceOf(undone).overrides).toEqual(OVERRIDES);
		});

		it("round-trips a change made from no prior selection", () => {
			const rt = runtime();
			const before = doc();
			const { ir, inverse } = rt.apply(
				before,
				{
					type: SET_VARIANT_COMMAND,
					instanceId: "inst-1",
					selection: { size: "lg" },
				},
				AT,
			);
			const undone = rt.apply(ir, inverse, AT).ir;
			// ABSENT, not `{}` — "no selection" has one representation, so the
			// undone document equals its pre-change self exactly (INV-10).
			expect(instanceOf(undone).variantSelection).toBeUndefined();
			expect("variantSelection" in instanceOf(undone)).toBe(false);
			expect(undone).toEqual(before);
		});
	});

	describe("refusals leave the document untouched", () => {
		it("rejects an unknown instance", () => {
			expect(() =>
				runtime().apply(
					doc(),
					{ type: SET_VARIANT_COMMAND, instanceId: "nope", selection: {} },
					AT,
				),
			).toThrow(CanvasCommandError);
		});

		it("rejects a component that declares no variants", () => {
			expect(() =>
				runtime().apply(
					doc({ withVariants: false }),
					{ type: SET_VARIANT_COMMAND, instanceId: "inst-1", selection: {} },
					AT,
				),
			).toThrow(/declares no variants/);
		});

		it("rejects an instance whose Source does not resolve", () => {
			// Writing a selection nothing can interpret would leave the document
			// carrying a claim it cannot honour.
			const orphanDoc = { ...doc(), components: {} } as CanvasIR;
			expect(() =>
				runtime().apply(
					orphanDoc,
					{ type: SET_VARIANT_COMMAND, instanceId: "inst-1", selection: {} },
					AT,
				),
			).toThrow(/no resolvable Source/);
		});

		it("changes nothing on a refusal", () => {
			const before = doc({ withVariants: false });
			const snapshot = structuredClone(before);
			try {
				runtime().apply(
					before,
					{ type: SET_VARIANT_COMMAND, instanceId: "inst-1", selection: {} },
					AT,
				);
			} catch {
				/* expected */
			}
			expect(before).toEqual(snapshot);
		});
	});
});

describe("previewVariantChange (T-026 step 4)", () => {
	it("reports the outcome per override WITHOUT mutating", () => {
		const before = doc({ overrides: OVERRIDES });
		const snapshot = structuredClone(before);
		const summary = previewVariantChange(before, "inst-1", { size: "lg" });

		expect(summary?.resolvedVariantId).toBe("v-lg");
		expect(summary?.outcomes).toEqual([
			{
				propertyId: "p-badge",
				outcome: "orphaned",
				reason: expect.stringContaining("p-badge"),
			},
			{ propertyId: "p-title", outcome: "preserved" },
		]);
		expect(before).toEqual(snapshot);
	});

	it("preserves everything when the target variant rebinds nothing", () => {
		const summary = previewVariantChange(
			doc({ overrides: OVERRIDES }),
			"inst-1",
			{
				size: "sm",
			},
		);
		expect(summary?.outcomes.every((o) => o.outcome === "preserved")).toBe(
			true,
		);
	});

	it("marks an override for an unadvertised property as already orphaned", () => {
		const summary = previewVariantChange(
			doc({
				overrides: {
					"p-ghost": { kind: "visibility", visible: true },
				},
			}),
			"inst-1",
			{ size: "sm" },
		);
		expect(summary?.outcomes[0]).toMatchObject({
			propertyId: "p-ghost",
			outcome: "orphaned",
		});
	});

	it("returns undefined for a non-instance or unknown node", () => {
		expect(previewVariantChange(doc(), "nope", {})).toBeUndefined();
	});

	it("preview and commit agree on the outcome set", () => {
		// A preview a user trusts must describe what the commit actually does.
		const before = doc({ overrides: OVERRIDES });
		const summary = previewVariantChange(before, "inst-1", { size: "lg" });
		const { ir } = runtime().apply(
			before,
			{
				type: SET_VARIANT_COMMAND,
				instanceId: "inst-1",
				selection: { size: "lg" },
				discardOrphans: true,
			},
			AT,
		);
		const kept = Object.keys(instanceOf(ir).overrides ?? {}).sort();
		const predicted = (summary?.outcomes ?? [])
			.filter((o) => o.outcome === "preserved")
			.map((o) => o.propertyId)
			.sort();
		expect(kept).toEqual(predicted);
	});
});
