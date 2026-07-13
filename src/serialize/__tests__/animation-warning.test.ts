import { describe, expect, it } from "vitest";
import type {
	CanvasGroupNode,
	CanvasIR,
	CanvasRectNode,
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

function rectNode(over: Partial<CanvasRectNode> = {}): CanvasRectNode {
	return {
		id: "rect1",
		type: "rect",
		transform: identity,
		bounds: { width: 10, height: 10 },
		zIndex: 0,
		fill: "#f00",
		...over,
	};
}

function ir(
	root: CanvasGroupNode,
	pageOver: Record<string, unknown> = {},
): CanvasIR {
	return {
		version: "2",
		id: "doc-anim",
		title: "Animation fixture",
		pages: [
			{
				id: "page-1",
				size: { width: 100, height: 100, unit: "px" },
				background: { kind: "solid", value: "#fff" },
				root,
				...pageOver,
			},
		],
		assets: {},
		metadata: { createdAt: "t0", updatedAt: "t0" },
	};
}

function rootGroup(children: CanvasRectNode[] = []): CanvasGroupNode {
	return {
		id: "root",
		type: "group",
		transform: identity,
		bounds: { width: 0, height: 0 },
		zIndex: 0,
		children,
	};
}

describe("SVG static export ignores animation metadata (FR-080)", () => {
	it("warns ANIMATION_IGNORED for a node carrying animation metadata, with the node id", async () => {
		const node = rectNode({
			meta: { animation: { kind: "fade", duration: 0.5 } },
		});
		const { warnings } = await serializePageToSvg(ir(rootGroup([node])), 0);
		const warning = warnings.find((w) => w.code === "ANIMATION_IGNORED");
		expect(warning).toBeDefined();
		expect(warning?.nodeId).toBe("rect1");
	});

	it("warns ANIMATION_IGNORED for a page carrying animation metadata, with no nodeId", async () => {
		const { warnings } = await serializePageToSvg(
			ir(rootGroup([]), { animation: { kind: "fade", duration: 0.5 } }),
			0,
		);
		const warning = warnings.find((w) => w.code === "ANIMATION_IGNORED");
		expect(warning).toBeDefined();
		expect(warning?.nodeId).toBeUndefined();
	});

	it("renders byte-identical SVG output with vs without animation metadata (static paths truly ignore it)", async () => {
		const plain = rectNode();
		const animated = rectNode({
			meta: { animation: { kind: "slide", duration: 1, direction: "up" } },
		});
		const { svg: svgPlain } = await serializePageToSvg(
			ir(rootGroup([plain])),
			0,
		);
		const { svg: svgAnimated } = await serializePageToSvg(
			ir(rootGroup([animated])),
			0,
		);
		expect(svgAnimated).toBe(svgPlain);
	});

	it("does not warn when no animation metadata is present", async () => {
		const { warnings } = await serializePageToSvg(
			ir(rootGroup([rectNode()])),
			0,
		);
		expect(warnings.some((w) => w.code === "ANIMATION_IGNORED")).toBe(false);
	});
});

describe("PDF static export ignores animation metadata (FR-080)", () => {
	/** A valid 1×1 transparent PNG (verified to embed via pdf-lib's decoder). */
	const PNG_1X1 =
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
	const PNG_1X1_BYTES = new Uint8Array(Buffer.from(PNG_1X1, "base64"));

	it("warns ANIMATION_IGNORED for a page carrying animation metadata, scoped by pageId", async () => {
		const { warnings } = await serializeDocumentToPdf(
			ir(rootGroup([]), { animation: { kind: "fade", duration: 0.5 } }),
			{
				rasters: [{ pageId: "page-1", image: PNG_1X1_BYTES }],
			},
		);
		const warning = warnings.find((w) => w.code === "ANIMATION_IGNORED");
		expect(warning).toBeDefined();
		expect(warning?.pageId).toBe("page-1");
	});

	it("does not warn when no page carries animation metadata", async () => {
		const { warnings } = await serializeDocumentToPdf(ir(rootGroup([])), {
			rasters: [{ pageId: "page-1", image: PNG_1X1_BYTES }],
		});
		expect(warnings.some((w) => w.code === "ANIMATION_IGNORED")).toBe(false);
	});
});
