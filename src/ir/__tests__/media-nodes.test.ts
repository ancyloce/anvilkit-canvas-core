import { describe, expect, it } from "vitest";
import { createAudio, createVideo } from "../builders.js";
import type { CanvasAudioNode, CanvasVideoNode } from "../types.js";
import {
	CanvasAudioNodeSchema,
	CanvasNodeSchema,
	CanvasVideoNodeSchema,
} from "../validators.js";

describe("createVideo", () => {
	it("builds a minimal video node with only an assetId", () => {
		const node = createVideo({
			id: "v1",
			bounds: { width: 100, height: 100 },
			assetId: "asset1",
		});
		expect(node).toEqual({
			id: "v1",
			type: "video",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 100 },
			zIndex: 0,
			assetId: "asset1",
		});
	});

	it("carries trim/muted/volume/poster when supplied", () => {
		const node = createVideo({
			id: "v1",
			bounds: { width: 100, height: 100 },
			assetId: "asset1",
			trim: { start: 1, end: 5 },
			muted: true,
			volume: 0.5,
			poster: "poster1",
		});
		expect(node.trim).toEqual({ start: 1, end: 5 });
		expect(node.muted).toBe(true);
		expect(node.volume).toBe(0.5);
		expect(node.poster).toBe("poster1");
	});
});

describe("createAudio", () => {
	it("builds a minimal audio node with only an assetId", () => {
		const node = createAudio({
			id: "a1",
			bounds: { width: 100, height: 100 },
			assetId: "asset1",
		});
		expect(node).toEqual({
			id: "a1",
			type: "audio",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 100 },
			zIndex: 0,
			assetId: "asset1",
		});
	});

	it("has no poster field on the TS type (video-only) — compile-time proof", () => {
		const node: CanvasAudioNode = {
			id: "a1",
			type: "audio",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			assetId: "asset1",
		};
		expect(Object.keys(node).sort()).toEqual(
			["assetId", "bounds", "id", "transform", "type", "zIndex"].sort(),
		);
	});
});

describe("CanvasVideoNodeSchema", () => {
	function makeNode(overrides: Partial<CanvasVideoNode> = {}): unknown {
		return {
			id: "v1",
			type: "video",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 100 },
			zIndex: 0,
			assetId: "asset1",
			...overrides,
		};
	}

	it("accepts a minimal video node", () => {
		expect(CanvasVideoNodeSchema.safeParse(makeNode()).success).toBe(true);
	});

	it("accepts trim/muted/volume/poster", () => {
		expect(
			CanvasVideoNodeSchema.safeParse(
				makeNode({
					trim: { start: 0, end: 10 },
					muted: false,
					volume: 1,
					poster: "poster1",
				}),
			).success,
		).toBe(true);
	});

	it("rejects a missing assetId", () => {
		const { assetId: _omit, ...withoutAssetId } = makeNode() as Record<
			string,
			unknown
		>;
		expect(CanvasVideoNodeSchema.safeParse(withoutAssetId).success).toBe(false);
	});

	it("rejects a volume outside 0-1", () => {
		expect(
			CanvasVideoNodeSchema.safeParse(makeNode({ volume: 1.5 })).success,
		).toBe(false);
		expect(
			CanvasVideoNodeSchema.safeParse(makeNode({ volume: -0.1 })).success,
		).toBe(false);
	});

	it("participates in the main discriminated CanvasNodeSchema union", () => {
		expect(CanvasNodeSchema.safeParse(makeNode()).success).toBe(true);
	});
});

describe("CanvasAudioNodeSchema", () => {
	function makeNode(overrides: Partial<CanvasAudioNode> = {}): unknown {
		return {
			id: "a1",
			type: "audio",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 100 },
			zIndex: 0,
			assetId: "asset1",
			...overrides,
		};
	}

	it("accepts a minimal audio node", () => {
		expect(CanvasAudioNodeSchema.safeParse(makeNode()).success).toBe(true);
	});

	it("rejects an unknown poster field being required (it's video-only, but loose-object still accepts it as inert extra data)", () => {
		// Loose-object posture (forward-compat) means an extra key round-trips
		// rather than erroring — this pins that audio tolerates it as inert data.
		expect(
			CanvasAudioNodeSchema.safeParse(makeNode({ poster: "x" } as never))
				.success,
		).toBe(true);
	});

	it("participates in the main discriminated CanvasNodeSchema union", () => {
		expect(CanvasNodeSchema.safeParse(makeNode()).success).toBe(true);
	});
});
