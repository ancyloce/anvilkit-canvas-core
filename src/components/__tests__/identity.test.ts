import { describe, expect, it } from "vitest";
import { createRect } from "../../ir/builders.js";
import type { CanvasComponentDefinition } from "../../ir/types.js";
import { CanvasComponentRegistrySchema } from "../../ir/validators.js";
import {
	createComponentIdFactories,
	findComponentProperty,
} from "../identity.js";

/**
 * M1-10 (plan 0023, TD §5.5): cross-definition Property-ID reuse is safe and
 * PERMITTED — lookup is scoped to one definition, and no cross-definition
 * uniqueness check exists anywhere to reject it.
 */

function definitionWithTitleProperty(
	id: string,
	propertyName: string,
): CanvasComponentDefinition {
	return {
		id,
		name: id,
		revision: 0,
		root: createRect({ id: `${id}-root`, bounds: { width: 10, height: 10 } }),
		properties: [
			{
				id: "prop-title",
				name: propertyName,
				nodeId: `${id}-root`,
				kind: "text",
				targetKind: "text",
			},
		],
	};
}

describe("component identity rules (M1-10)", () => {
	it("resolves a reused Property ID unambiguously via its own definition", () => {
		const a = definitionWithTitleProperty("cmp-a", "Headline");
		const b = definitionWithTitleProperty("cmp-b", "Caption");

		expect(findComponentProperty(a, "prop-title")?.name).toBe("Headline");
		expect(findComponentProperty(b, "prop-title")?.name).toBe("Caption");
		expect(findComponentProperty(a, "prop-missing")).toBeUndefined();
	});

	it("the Registry schema accepts cross-definition Property-ID reuse", () => {
		expect(() =>
			CanvasComponentRegistrySchema.parse({
				"cmp-a": definitionWithTitleProperty("cmp-a", "Headline"),
				"cmp-b": definitionWithTitleProperty("cmp-b", "Caption"),
			}),
		).not.toThrow();
	});

	it("id factories are injected, never ad-hoc", () => {
		let n = 0;
		const factories = createComponentIdFactories(() => `seq-${++n}`);
		expect(factories.componentId()).toBe("seq-1");
		expect(factories.propertyId()).toBe("seq-2");
		expect(factories.sourceNodeId()).toBe("seq-3");

		// The default factory still yields distinct opaque ids.
		const defaults = createComponentIdFactories();
		expect(defaults.componentId()).not.toBe(defaults.componentId());
	});
});
