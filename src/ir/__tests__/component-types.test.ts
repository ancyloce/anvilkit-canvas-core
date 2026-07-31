import { describe, expect, it } from "vitest";
import { createCanvasIR, createRect } from "../builders.js";
import { localComponentIdOf } from "../component-source.js";
import type {
	CanvasComponentColorProperty,
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasComponentOverrideMap,
	CanvasComponentRegistry,
	CanvasIR,
	CanvasLeafNode,
	CanvasNodeByKind,
} from "../types.js";
import { isContainerNode } from "../walkers.js";

/**
 * M1-02/03/04 type contracts (plan 0023): the component data model exists,
 * `component-instance` widens the node union as a NON-container leaf, and the
 * frozen decisions (no stroke target, optional registry) hold at the type
 * level. Compile errors here are contract regressions.
 */
describe("component data-model types (M1-02/03/04)", () => {
	it("keeps `components` optional — a component-free document stays valid", () => {
		const ir = createCanvasIR({ id: "doc" });
		expect(ir.components).toBeUndefined();

		const definition: CanvasComponentDefinition = {
			id: "cmp-cta",
			name: "CTA",
			revision: 1,
			root: createRect({ id: "cta-root", bounds: { width: 10, height: 10 } }),
			properties: [],
		};
		const registry: CanvasComponentRegistry = { "cmp-cta": definition };
		const withComponents: CanvasIR = { ...ir, components: registry };
		expect(withComponents.components?.["cmp-cta"]?.revision).toBe(1);
	});

	it("rejects `stroke` as a color-property target (frozen: fill | background)", () => {
		const valid: CanvasComponentColorProperty = {
			id: "prop-bg",
			name: "Background",
			nodeId: "cta-root",
			kind: "color",
			targetField: "background",
		};
		expect(valid.targetField).toBe("background");

		const invalid: CanvasComponentColorProperty = {
			id: "prop-stroke",
			name: "Stroke",
			nodeId: "cta-root",
			kind: "color",
			// @ts-expect-error - stroke is string-typed in the IR, not CanvasFill;
			// a CanvasFill-valued override has no legal stroke target (C-17).
			targetField: "stroke",
		};
		expect(invalid.kind).toBe("color");
	});

	it("makes component-instance a union member and a non-container leaf", () => {
		const overrides: CanvasComponentOverrideMap = {
			"prop-title": { kind: "text", value: { kind: "plain", text: "Hi" } },
			"prop-media": { kind: "image", assetId: "a1" },
			"prop-bg": { kind: "color", value: "#ff0000" },
			"prop-badge": { kind: "visibility", visible: false },
		};
		const instance: CanvasComponentInstanceNode = {
			id: "inst-1",
			type: "component-instance",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 200, height: 160 },
			source: { kind: "local", componentId: "cmp-cta" },
			overrides,
		};

		const byKind: CanvasNodeByKind<"component-instance"> = instance;
		expect(byKind.source).toEqual({ kind: "local", componentId: "cmp-cta" });
		expect(localComponentIdOf(byKind.source)).toBe("cmp-cta");

		// NOT a container: no children at the type level, leaf at runtime.
		const leaf: CanvasLeafNode = instance;
		expect(isContainerNode(leaf)).toBe(false);
		// @ts-expect-error - an instance has no children; the expanded subtree
		// is virtual (resolve-time), never persisted on the node.
		expect(instance.children).toBeUndefined();
	});
});
