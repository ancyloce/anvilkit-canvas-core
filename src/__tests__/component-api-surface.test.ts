import { describe, expect, it } from "vitest";
import * as root from "../index.js";

/**
 * M1-11 (plan 0023, A-3): the component surface ships through the curated
 * barrel — the intended names are present at the package root, and module
 * internals never leak into it. A name appearing here uninvited is an
 * accidental API commitment the snapshot gate would then freeze.
 */
describe("component public surface (M1-11)", () => {
	it("exposes the intended component API at the package root", () => {
		const names = new Set(Object.keys(root));
		for (const expected of [
			"walkDocument",
			"createComponentInstance",
			"createComponentIdFactories",
			"findComponentProperty",
			"buildCanvasComponentRegistrySchema",
			"CanvasComponentRegistrySchema",
			"CanvasComponentInstanceNodeSchema",
			"CanvasComponentPropertySchema",
			"CanvasComponentOverrideSchema",
			"CanvasTextOverrideValueSchema",
			"omitEmptyComponents",
			"MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT",
			"MAX_COMPONENT_NESTED_DEPTH",
		]) {
			expect(names.has(expected), `missing: ${expected}`).toBe(true);
		}
	});

	it("keeps module internals out of the package root", () => {
		const names = new Set(Object.keys(root));
		for (const internal of [
			// brand/apply.ts structural patch helpers
			"patchNodeTree",
			"patchDefinitions",
			"runBrandTransform",
			// walkers/validators privates
			"walkDocumentSubtree",
			"countSubtreeNodes",
			// identity private default factory
			"defaultIdFactory",
		]) {
			expect(names.has(internal), `leaked: ${internal}`).toBe(false);
		}
	});
});
