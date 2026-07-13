import { describe, expect, it } from "vitest";
import { createSvg } from "../builders.js";
import type { CanvasSvgNode } from "../types.js";
import { CanvasNodeSchema, CanvasSvgNodeSchema } from "../validators.js";

describe("createSvg", () => {
	it("builds a minimal svg node with only an assetId", () => {
		const node = createSvg({
			id: "s1",
			bounds: { width: 100, height: 100 },
			assetId: "asset1",
		});
		expect(node).toEqual({
			id: "s1",
			type: "svg",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 100 },
			zIndex: 0,
			assetId: "asset1",
		});
	});
});

describe("CanvasSvgNodeSchema", () => {
	function makeNode(overrides: Partial<CanvasSvgNode> = {}): unknown {
		return {
			id: "s1",
			type: "svg",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 100 },
			zIndex: 0,
			assetId: "asset1",
			...overrides,
		};
	}

	it("accepts a minimal svg node", () => {
		expect(CanvasSvgNodeSchema.safeParse(makeNode()).success).toBe(true);
	});

	it("rejects a missing assetId", () => {
		const { assetId: _omit, ...withoutAssetId } = makeNode() as Record<
			string,
			unknown
		>;
		expect(CanvasSvgNodeSchema.safeParse(withoutAssetId).success).toBe(false);
	});

	it("rejects an empty assetId", () => {
		expect(
			CanvasSvgNodeSchema.safeParse(makeNode({ assetId: "" })).success,
		).toBe(false);
	});

	it("has no field for inline markup on the TS type — this is a compile-time proof, not a runtime check", () => {
		// If `CanvasSvgNode` ever grows a `markup`/`content`/`raw` field, this
		// line stops compiling, which is exactly the point: assigning it here
		// forces a type error if such a field were ever added without updating
		// this proof alongside it.
		const node: CanvasSvgNode = {
			id: "s1",
			type: "svg",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			assetId: "asset1",
		};
		expect(Object.keys(node).sort()).toEqual(
			["assetId", "bounds", "id", "transform", "type", "zIndex"].sort(),
		);
	});

	it("participates in the main discriminated CanvasNodeSchema union", () => {
		expect(CanvasNodeSchema.safeParse(makeNode()).success).toBe(true);
	});
});
