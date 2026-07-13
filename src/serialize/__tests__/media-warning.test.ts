import { describe, expect, it } from "vitest";
import { createAudio, createVideo } from "../../ir/builders.js";
import type {
	CanvasAssetRef,
	CanvasGroupNode,
	CanvasIR,
	CanvasTransform,
} from "../../ir/types.js";
import { serializeDocumentToPdf } from "../pdf.js";
import { serializePageToSvg } from "../svg.js";

const identity: CanvasTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

function rootGroup(
	children: CanvasGroupNode["children"] = [],
): CanvasGroupNode {
	return {
		id: "root",
		type: "group",
		transform: identity,
		bounds: { width: 0, height: 0 },
		zIndex: 0,
		children,
	};
}

function ir(
	root: CanvasGroupNode,
	assets: Record<string, CanvasAssetRef> = {},
): CanvasIR {
	return {
		version: "2",
		id: "doc-media",
		title: "Media fixture",
		pages: [
			{
				id: "page-1",
				size: { width: 100, height: 100, unit: "px" },
				background: { kind: "solid", value: "#fff" },
				root,
			},
		],
		assets,
		metadata: { createdAt: "t0", updatedAt: "t0" },
	};
}

describe("SVG static export ignores video/audio content (FR-081)", () => {
	it("warns VIDEO_UNSUPPORTED and renders nothing when a video node has no poster", async () => {
		const video = createVideo({
			id: "v1",
			bounds: { width: 10, height: 10 },
			assetId: "video-asset",
		});
		const { svg, warnings } = await serializePageToSvg(
			ir(rootGroup([video])),
			0,
		);
		expect(warnings.some((w) => w.code === "VIDEO_UNSUPPORTED")).toBe(true);
		expect(svg).not.toContain("<image");
	});

	it("warns VIDEO_UNSUPPORTED and renders the poster asset as a static <image> fallback", async () => {
		const video = createVideo({
			id: "v1",
			bounds: { width: 10, height: 10 },
			assetId: "video-asset",
			poster: "poster-asset",
		});
		const { svg, warnings } = await serializePageToSvg(
			ir(rootGroup([video]), {
				"poster-asset": {
					id: "poster-asset",
					uri: "data:image/png;base64,SGk=",
				},
			}),
			0,
		);
		expect(warnings.some((w) => w.code === "VIDEO_UNSUPPORTED")).toBe(true);
		expect(svg).toContain("<image");
		expect(svg).toContain("data:image/png;base64,SGk=");
	});

	it("warns AUDIO_UNSUPPORTED and renders nothing for an audio node", async () => {
		const audio = createAudio({
			id: "a1",
			bounds: { width: 10, height: 10 },
			assetId: "audio-asset",
		});
		const { svg, warnings } = await serializePageToSvg(
			ir(rootGroup([audio])),
			0,
		);
		expect(warnings.some((w) => w.code === "AUDIO_UNSUPPORTED")).toBe(true);
		expect(svg).not.toContain("<image");
	});
});

describe("PDF static export flags video/audio content (FR-081)", () => {
	const PNG_1X1 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
	const PNG_1X1_BYTES = new Uint8Array(Buffer.from(PNG_1X1, "base64"));

	it("emits one VIDEO_UNSUPPORTED warning per page regardless of how many video nodes it has", async () => {
		const videoA = createVideo({
			id: "va",
			bounds: { width: 10, height: 10 },
			assetId: "asset-a",
		});
		const videoB = createVideo({
			id: "vb",
			bounds: { width: 10, height: 10 },
			assetId: "asset-b",
		});
		const { warnings } = await serializeDocumentToPdf(
			ir(rootGroup([videoA, videoB])),
			{ rasters: [{ pageId: "page-1", image: PNG_1X1_BYTES }] },
		);
		expect(warnings.filter((w) => w.code === "VIDEO_UNSUPPORTED")).toHaveLength(
			1,
		);
	});

	it("emits AUDIO_UNSUPPORTED for a page containing an audio node", async () => {
		const audio = createAudio({
			id: "a1",
			bounds: { width: 10, height: 10 },
			assetId: "audio-asset",
		});
		const { warnings } = await serializeDocumentToPdf(ir(rootGroup([audio])), {
			rasters: [{ pageId: "page-1", image: PNG_1X1_BYTES }],
		});
		expect(warnings.some((w) => w.code === "AUDIO_UNSUPPORTED")).toBe(true);
	});

	it("does not warn when no page contains video/audio nodes", async () => {
		const { warnings } = await serializeDocumentToPdf(ir(rootGroup([])), {
			rasters: [{ pageId: "page-1", image: PNG_1X1_BYTES }],
		});
		expect(
			warnings.some(
				(w) => w.code === "VIDEO_UNSUPPORTED" || w.code === "AUDIO_UNSUPPORTED",
			),
		).toBe(false);
	});
});
