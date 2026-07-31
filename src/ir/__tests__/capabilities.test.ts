import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createComponentInstance,
	createRect,
} from "../builders.js";
import {
	CANVAS_BRAND_GOVERNANCE_CAPABILITY,
	CANVAS_COMPONENTS_EXTERNAL_CAPABILITY,
	CANVAS_COMPONENTS_VARIANTS_CAPABILITY,
	computeRequiredCapabilities,
	withComputedCapabilities,
} from "../capabilities.js";
import {
	CANVAS_COMPONENTS_LOCAL_CAPABILITY,
	CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
	CANVAS_LAYOUT_AUTO_CAPABILITY,
} from "../invariants.js";
import { snapshotKey } from "../snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
} from "../types.js";

const REF: CanvasExternalComponentRef = {
	kind: "library",
	libraryId: "acme",
	componentId: "button",
	version: "1.0.0",
	integrity: `sha256-${"A".repeat(43)}`,
};

function docWith(nodes: CanvasNode[], extra: Partial<CanvasIR> = {}): CanvasIR {
	const ir = createCanvasIR({ id: "doc", now: () => "t0" });
	const root = ir.pages[0]?.root as CanvasGroupNode;
	root.children.push(...nodes);
	return { ...ir, ...extra } as CanvasIR;
}

const instance = (source: Parameters<typeof createComponentInstance>[0]) =>
	createComponentInstance({ bounds: { width: 10, height: 10 }, ...source });

describe("computeRequiredCapabilities — declare only what is used (T-013)", () => {
	it("declares NOTHING for a plain document", () => {
		const plain = docWith([createRect({ bounds: { width: 5, height: 5 } })]);
		expect(computeRequiredCapabilities(plain)).toEqual([]);
	});

	it("declares components.external.v1 for an external instance", () => {
		const doc = docWith([instance({ source: REF })]);
		expect(computeRequiredCapabilities(doc)).toEqual([
			CANVAS_COMPONENTS_EXTERNAL_CAPABILITY,
		]);
	});

	it("declares components.local.v1 for a local instance, and NOT external", () => {
		const doc = docWith([instance({ componentId: "cmp-a" })]);
		expect(computeRequiredCapabilities(doc)).toEqual([
			CANVAS_COMPONENTS_LOCAL_CAPABILITY,
		]);
	});

	it("declares external for a document holding snapshots even with no instance yet", () => {
		const doc = docWith([], {
			externalComponentSnapshots: {
				[snapshotKey(REF)]: {
					ref: REF,
					definition: {
						id: "button",
						name: "Button",
						revision: 1,
						root: createRect({ bounds: { width: 1, height: 1 } }),
						properties: [],
					},
					dependencies: [],
					canonicalFormatVersion: 1,
				},
			},
		} as Partial<CanvasIR>);
		expect(computeRequiredCapabilities(doc)).toContain(
			CANVAS_COMPONENTS_EXTERNAL_CAPABILITY,
		);
	});

	it("adds overrides only when an instance actually carries them", () => {
		const without = docWith([instance({ componentId: "cmp-a" })]);
		expect(computeRequiredCapabilities(without)).not.toContain(
			CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
		);

		const withOverrides = docWith([
			instance({
				componentId: "cmp-a",
				overrides: {
					"p-1": { kind: "visibility", visible: false },
				},
			}),
		]);
		expect(computeRequiredCapabilities(withOverrides)).toContain(
			CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
		);
	});

	it("combines every trigger present, sorted and deduplicated", () => {
		const doc = docWith([
			instance({ componentId: "cmp-a" }),
			instance({
				source: REF,
				overrides: { "p-1": { kind: "visibility", visible: true } },
			}),
			instance({ source: REF }),
		]);
		const result = computeRequiredCapabilities(doc);
		expect(result).toEqual([
			CANVAS_COMPONENTS_EXTERNAL_CAPABILITY,
			CANVAS_COMPONENTS_LOCAL_CAPABILITY,
			CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
		]);
		expect(result).toEqual([...new Set(result)]);
		expect(result).toEqual([...result].sort());
	});

	it("still detects layout intent through the SHARED predicate", () => {
		// Not a reimplementation: `nodeCarriesLayoutIntent` is the same predicate
		// the invariant and the SVG serializer use, so "capability required" and
		// "resolution required" cannot drift apart.
		const frame = {
			id: "f1",
			type: "frame",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			children: [],
			autoLayout: { direction: "horizontal", gap: 4 },
		} as unknown as CanvasNode;
		expect(computeRequiredCapabilities(docWith([frame]))).toContain(
			CANVAS_LAYOUT_AUTO_CAPABILITY,
		);
	});

	it("finds an instance nested inside a local Source tree, not just on a page", () => {
		const doc = docWith([], {
			components: {
				"cmp-outer": {
					id: "cmp-outer",
					name: "Outer",
					revision: 1,
					root: {
						id: "outer-root",
						type: "group",
						transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
						bounds: { width: 10, height: 10 },
						zIndex: 0,
						children: [instance({ source: REF })],
					} as unknown as CanvasNode,
					properties: [],
				},
			},
		} as Partial<CanvasIR>);
		expect(computeRequiredCapabilities(doc)).toContain(
			CANVAS_COMPONENTS_EXTERNAL_CAPABILITY,
		);
	});

	describe("preserves declarations this build does not understand", () => {
		it("keeps an unknown capability a newer peer declared", () => {
			// The load-bearing rule: the IR is CRDT-replicated and loose, so a
			// document can arrive carrying BOTH a capability this build never heard
			// of and the content requiring it. Recomputing and writing the result
			// must not strip the declaration while keeping the content.
			const doc = docWith([], {
				compatibility: {
					schemaVersion: "3",
					minReaderSchemaVersion: "3",
					requiredCapabilities: ["motion.timeline.v9"],
				},
			} as Partial<CanvasIR>);
			expect(computeRequiredCapabilities(doc)).toEqual(["motion.timeline.v9"]);
		});

		it("keeps M3/M4 capabilities that are declared but not yet emitted here", () => {
			const doc = docWith([instance({ source: REF })], {
				compatibility: {
					schemaVersion: "3",
					minReaderSchemaVersion: "3",
					requiredCapabilities: [
						CANVAS_COMPONENTS_VARIANTS_CAPABILITY,
						CANVAS_BRAND_GOVERNANCE_CAPABILITY,
					],
				},
			} as Partial<CanvasIR>);
			const result = computeRequiredCapabilities(doc);
			expect(result).toContain(CANVAS_COMPONENTS_VARIANTS_CAPABILITY);
			expect(result).toContain(CANVAS_BRAND_GOVERNANCE_CAPABILITY);
			expect(result).toContain(CANVAS_COMPONENTS_EXTERNAL_CAPABILITY);
		});

		it("does not duplicate a capability that is both declared and derived", () => {
			const doc = docWith([instance({ source: REF })], {
				compatibility: {
					schemaVersion: "3",
					minReaderSchemaVersion: "3",
					requiredCapabilities: [CANVAS_COMPONENTS_EXTERNAL_CAPABILITY],
				},
			} as Partial<CanvasIR>);
			expect(computeRequiredCapabilities(doc)).toEqual([
				CANVAS_COMPONENTS_EXTERNAL_CAPABILITY,
			]);
		});
	});

	it("is deterministic and idempotent", () => {
		const doc = docWith([
			instance({ source: REF }),
			instance({ componentId: "a" }),
		]);
		const once = computeRequiredCapabilities(doc);
		expect(computeRequiredCapabilities(doc)).toEqual(once);
		expect(computeRequiredCapabilities(withComputedCapabilities(doc))).toEqual(
			once,
		);
	});
});

describe("withComputedCapabilities (save path)", () => {
	it("omits `compatibility` entirely when nothing is required", () => {
		const plain = docWith([createRect({ bounds: { width: 5, height: 5 } })]);
		expect("compatibility" in withComputedCapabilities(plain)).toBe(false);
	});

	it("writes the derived list and keeps schemaVersion in step", () => {
		const doc = withComputedCapabilities(docWith([instance({ source: REF })]));
		expect(doc.compatibility?.requiredCapabilities).toEqual([
			CANVAS_COMPONENTS_EXTERNAL_CAPABILITY,
		]);
		expect(doc.compatibility?.schemaVersion).toBe(doc.version);
	});

	it("preserves an existing minReaderSchemaVersion rather than narrowing it", () => {
		const doc = docWith([instance({ source: REF })], {
			compatibility: {
				schemaVersion: "3",
				minReaderSchemaVersion: "4",
				requiredCapabilities: [],
			},
		} as Partial<CanvasIR>);
		expect(
			withComputedCapabilities(doc).compatibility?.minReaderSchemaVersion,
		).toBe("4");
	});

	it("drops a stale `compatibility` when the content no longer needs one", () => {
		const doc = docWith([], {
			compatibility: {
				schemaVersion: "3",
				minReaderSchemaVersion: "3",
				requiredCapabilities: [],
			},
		} as Partial<CanvasIR>);
		expect("compatibility" in withComputedCapabilities(doc)).toBe(false);
	});
});
