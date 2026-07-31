import { describe, expect, it } from "vitest";

import { CanvasCommandError } from "../../commands/runtime.js";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import { createCanvasIR, createComponentInstance } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
	CanvasIR,
} from "../../ir/types.js";
import { findNode } from "../../ir/walkers.js";
import type { CanvasValidatedExternalSnapshot } from "../admission.js";
import {
	createSourceChangeCommandHandlers,
	previewSourceChange,
	SWAP_SOURCE_COMMAND,
	UPDATE_SOURCE_COMMAND,
} from "../commands/update-source.js";

/**
 * T-030 / T-032 — explicit, atomic, reversible version change and swap.
 */

const AT = { now: () => "t0" } as const;

function runtime() {
	return createCanvasRuntime([
		{
			id: "plan-0021-source",
			commands: [...createSourceChangeCommandHandlers()],
		},
	]);
}

function ref(
	componentId: string,
	version: string,
	seed = `${componentId}${version}`,
): CanvasExternalComponentRef {
	return {
		kind: "library",
		libraryId: "acme",
		componentId,
		version,
		integrity: `sha256-${seed.padEnd(43, "x").slice(0, 43)}`,
	};
}

function text(id: string, semanticKey?: string): CanvasComponentProperty {
	return {
		id,
		name: id,
		nodeId: `${id}-node`,
		kind: "text",
		targetKind: "text",
		...(semanticKey ? { semanticKey } : {}),
	} as CanvasComponentProperty;
}

function definition(
	componentId: string,
	properties: CanvasComponentProperty[],
): CanvasComponentDefinition {
	return {
		id: componentId,
		name: componentId,
		revision: 1,
		root: {
			id: `${componentId}-root`,
			type: "frame",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 40 },
			zIndex: 0,
			children: [],
		},
		properties,
	} as CanvasComponentDefinition;
}

function snapshot(
	self: CanvasExternalComponentRef,
	properties: CanvasComponentProperty[],
): CanvasValidatedExternalSnapshot {
	return {
		ref: self,
		definition: definition(self.componentId, properties),
		dependencies: [],
		canonicalFormatVersion: 1,
	} as unknown as CanvasValidatedExternalSnapshot;
}

const V1 = ref("button", "1.0.0");
const V2 = ref("button", "2.0.0");
const OTHER = ref("card", "1.0.0");

const OVERRIDES: CanvasComponentOverrideMap = {
	"p-title": { kind: "text", value: { kind: "plain", text: "Hello" } },
};

function doc(
	options: {
		properties?: CanvasComponentProperty[];
		overrides?: CanvasComponentOverrideMap;
		instanceCount?: number;
	} = {},
): CanvasIR {
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	const stored = snapshot(V1, options.properties ?? [text("p-title")]);
	let ir: CanvasIR = {
		...base,
		externalComponentSnapshots: {
			[snapshotKey(V1)]: stored as unknown as CanvasExternalComponentSnapshot,
		},
	};
	for (let i = 0; i < (options.instanceCount ?? 1); i += 1) {
		ir = insertNode(ir, {
			parentId: ir.pages[0]?.root.id as string,
			node: createComponentInstance({
				id: `inst-${i + 1}`,
				source: V1,
				bounds: { width: 100, height: 40 },
				...(options.overrides ? { overrides: options.overrides } : {}),
			}),
			now: () => "t0",
		});
	}
	return ir;
}

function instanceOf(ir: CanvasIR, id = "inst-1"): CanvasComponentInstanceNode {
	return findNode(ir, id)?.node as CanvasComponentInstanceNode;
}

describe("component-instance.update-source (T-030)", () => {
	it("moves named instances to the new version and stores its snapshot", () => {
		const { ir } = runtime().apply(
			doc(),
			{
				type: UPDATE_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(V2, [text("p-title")]),
				instanceIds: ["inst-1"],
			},
			AT,
		);
		expect(instanceOf(ir).source).toEqual(V2);
		expect(ir.externalComponentSnapshots?.[snapshotKey(V2)]).toBeDefined();
	});

	it("KEEPS the old snapshot so Undo never needs a Provider (T-030 step 4)", () => {
		const { ir } = runtime().apply(
			doc(),
			{
				type: UPDATE_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(V2, [text("p-title")]),
				instanceIds: ["inst-1"],
			},
			AT,
		);
		expect(ir.externalComponentSnapshots?.[snapshotKey(V1)]).toBeDefined();
		expect(Object.keys(ir.externalComponentSnapshots ?? {})).toHaveLength(2);
	});

	it("applies ONLY to the named instances (§12.6 deterministic replay)", () => {
		// A replay on a document that has since gained instances must not affect
		// more than the user previewed.
		const { ir } = runtime().apply(
			doc({ instanceCount: 3 }),
			{
				type: UPDATE_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(V2, [text("p-title")]),
				instanceIds: ["inst-2"],
			},
			AT,
		);
		expect(instanceOf(ir, "inst-1").source).toEqual(V1);
		expect(instanceOf(ir, "inst-2").source).toEqual(V2);
		expect(instanceOf(ir, "inst-3").source).toEqual(V1);
	});

	it("carries an override onto a renamed property via semanticKey", () => {
		const { ir } = runtime().apply(
			doc({
				properties: [text("p-title", "acme:title")],
				overrides: OVERRIDES,
			}),
			{
				type: UPDATE_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(V2, [text("p-heading", "acme:title")]),
				instanceIds: ["inst-1"],
			},
			AT,
		);
		expect(instanceOf(ir).overrides?.["p-heading"]).toEqual(
			OVERRIDES["p-title"],
		);
	});

	it("RETAINS an orphaned override rather than dropping it", () => {
		const { ir } = runtime().apply(
			doc({ overrides: OVERRIDES }),
			{
				type: UPDATE_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(V2, [text("p-different")]),
				instanceIds: ["inst-1"],
			},
			AT,
		);
		expect(instanceOf(ir).overrides?.["p-title"]).toEqual(OVERRIDES["p-title"]);
	});

	describe("refuses without touching the document", () => {
		it("rejects a target that changes component identity", () => {
			// Identity change is a SWAP; conflating them would let an "update"
			// silently replace one component with another.
			const before = doc();
			const snap = structuredClone(before);
			expect(() =>
				runtime().apply(
					before,
					{
						type: UPDATE_SOURCE_COMMAND,
						from: V1,
						candidate: snapshot(OTHER, [text("p-title")]),
						instanceIds: ["inst-1"],
					},
					AT,
				),
			).toThrow(/Changing component identity is a swap/);
			expect(before).toEqual(snap);
		});

		it("rejects an INCOMPATIBLE target (a property changed type)", () => {
			const colorProp = {
				id: "p-title",
				name: "Title",
				nodeId: "n",
				kind: "color",
				targetField: "fill",
			} as CanvasComponentProperty;
			expect(() =>
				runtime().apply(
					doc(),
					{
						type: UPDATE_SOURCE_COMMAND,
						from: V1,
						candidate: snapshot(V2, [colorProp]),
						instanceIds: ["inst-1"],
					},
					AT,
				),
			).toThrow(/Use swap to change deliberately/);
		});

		it("rejects when an instance no longer carries the previewed version", () => {
			// A stale preview must abort, not apply to a subset.
			const before = doc({ instanceCount: 2 });
			const moved = runtime().apply(
				before,
				{
					type: UPDATE_SOURCE_COMMAND,
					from: V1,
					candidate: snapshot(V2, [text("p-title")]),
					instanceIds: ["inst-1"],
				},
				AT,
			).ir;
			const snap = structuredClone(moved);
			expect(() =>
				runtime().apply(
					moved,
					{
						type: UPDATE_SOURCE_COMMAND,
						from: V1,
						candidate: snapshot(V2, [text("p-title")]),
						instanceIds: ["inst-1", "inst-2"],
					},
					AT,
				),
			).toThrow(/no longer references the version/);
			expect(moved).toEqual(snap);
		});

		it("rejects an empty instance list", () => {
			expect(() =>
				runtime().apply(
					doc(),
					{
						type: UPDATE_SOURCE_COMMAND,
						from: V1,
						candidate: snapshot(V2, [text("p-title")]),
						instanceIds: [],
					},
					AT,
				),
			).toThrow(CanvasCommandError);
		});

		it("rejects when the CURRENT version is not stored", () => {
			const orphan = { ...doc(), externalComponentSnapshots: {} } as CanvasIR;
			expect(() =>
				runtime().apply(
					orphan,
					{
						type: UPDATE_SOURCE_COMMAND,
						from: V1,
						candidate: snapshot(V2, [text("p-title")]),
						instanceIds: ["inst-1"],
					},
					AT,
				),
			).toThrow(/No stored snapshot for the current version/);
		});
	});

	describe("inverse (AC-005)", () => {
		it("restores refs, overrides and the registry exactly", () => {
			const rt = runtime();
			const before = doc({ overrides: OVERRIDES });
			const { ir, inverse } = rt.apply(
				before,
				{
					type: UPDATE_SOURCE_COMMAND,
					from: V1,
					candidate: snapshot(V2, [text("p-different")]),
					instanceIds: ["inst-1"],
				},
				AT,
			);
			expect(rt.apply(ir, inverse, AT).ir).toEqual(before);
		});

		it("restores every instance in a multi-instance update", () => {
			const rt = runtime();
			const before = doc({ instanceCount: 3 });
			const { ir, inverse } = rt.apply(
				before,
				{
					type: UPDATE_SOURCE_COMMAND,
					from: V1,
					candidate: snapshot(V2, [text("p-title")]),
					instanceIds: ["inst-1", "inst-2", "inst-3"],
				},
				AT,
			);
			expect(rt.apply(ir, inverse, AT).ir).toEqual(before);
		});

		it("redoes through the inverse's own inverse", () => {
			const rt = runtime();
			const { ir, inverse } = rt.apply(
				doc(),
				{
					type: UPDATE_SOURCE_COMMAND,
					from: V1,
					candidate: snapshot(V2, [text("p-title")]),
					instanceIds: ["inst-1"],
				},
				AT,
			);
			const undone = rt.apply(ir, inverse, AT);
			expect(rt.apply(undone.ir, undone.inverse, AT).ir).toEqual(ir);
		});
	});
});

describe("component-instance.swap-source (T-032)", () => {
	it("ALLOWS a component identity change, unlike update", () => {
		const { ir } = runtime().apply(
			doc(),
			{
				type: SWAP_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(OTHER, [text("p-title")]),
				instanceIds: ["inst-1"],
			},
			AT,
		);
		expect(instanceOf(ir).source).toEqual(OTHER);
	});

	it("allows an incompatible target, since a swap is deliberate", () => {
		const colorProp = {
			id: "p-title",
			name: "Title",
			nodeId: "n",
			kind: "color",
			targetField: "fill",
		} as CanvasComponentProperty;
		const { ir } = runtime().apply(
			doc({ overrides: OVERRIDES }),
			{
				type: SWAP_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(OTHER, [colorProp]),
				instanceIds: ["inst-1"],
			},
			AT,
		);
		// Blocked override retained, not silently applied to a mismatched type.
		expect(instanceOf(ir).overrides?.["p-title"]).toEqual(OVERRIDES["p-title"]);
	});

	it("RETAINS a variant selection across a swap (OD-07 collapse rule)", () => {
		const rt = runtime();
		const base = doc();
		const withSelection = {
			...base,
			pages: base.pages,
		} as CanvasIR;
		const seeded = (() => {
			const node = instanceOf(withSelection);
			(node as { variantSelection?: unknown }).variantSelection = {
				size: "lg",
			};
			return withSelection;
		})();

		const { ir } = rt.apply(
			seeded,
			{
				type: SWAP_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(OTHER, [text("p-title")]),
				instanceIds: ["inst-1"],
			},
			AT,
		);
		// Retained rather than reset, so a swap back restores it.
		expect(instanceOf(ir).variantSelection).toEqual({ size: "lg" });
	});

	it("is fully reversible", () => {
		const rt = runtime();
		const before = doc({ overrides: OVERRIDES });
		const { ir, inverse } = rt.apply(
			before,
			{
				type: SWAP_SOURCE_COMMAND,
				from: V1,
				candidate: snapshot(OTHER, [text("p-title")]),
				instanceIds: ["inst-1"],
			},
			AT,
		);
		expect(rt.apply(ir, inverse, AT).ir).toEqual(before);
	});
});

describe("previewSourceChange (§31.3)", () => {
	it("returns the same report the command will act on", () => {
		const before = doc();
		const target = definition("button", [text("p-different")]);
		const report = previewSourceChange(before, V1, target);
		expect(report?.classification).toBe("review-required");
		expect(report?.properties[0]?.kind).toBe("orphaned");
	});

	it("does not mutate", () => {
		const before = doc();
		const snap = structuredClone(before);
		previewSourceChange(before, V1, definition("button", [text("x")]));
		expect(before).toEqual(snap);
	});

	it("returns undefined when the current version is not stored", () => {
		const orphan = { ...doc(), externalComponentSnapshots: {} } as CanvasIR;
		expect(
			previewSourceChange(orphan, V1, definition("button", [text("x")])),
		).toBeUndefined();
	});
});
