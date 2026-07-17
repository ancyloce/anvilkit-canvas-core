import { describe, expect, it } from "vitest";
import type {
	CanvasAssetRef,
	CanvasGroupNode,
	CanvasImageFitMode,
	CanvasImageNode,
	CanvasIR,
	CanvasTransform,
} from "../../ir/types.js";
import { serializePageToSvg } from "../svg.js";

const identity: CanvasTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

const DATA_PNG = "data:image/png;base64,SGk=";

function imageNode(
	fitMode?: CanvasImageFitMode,
	crop?: CanvasImageNode["crop"],
): CanvasImageNode {
	return {
		id: "img-1",
		type: "image",
		transform: identity,
		bounds: { width: 200, height: 100 },
		zIndex: 0,
		assetId: "a1",
		...(fitMode !== undefined ? { fitMode } : {}),
		...(crop !== undefined ? { crop } : {}),
	};
}

function ir(
	node: CanvasImageNode,
	asset: Partial<CanvasAssetRef> = {},
): CanvasIR {
	const root: CanvasGroupNode = {
		id: "root",
		type: "group",
		transform: identity,
		bounds: { width: 200, height: 100 },
		zIndex: 0,
		children: [node],
	};
	return {
		version: "2",
		id: "doc-fit",
		title: "Fit fixture",
		pages: [
			{
				id: "page-1",
				size: { width: 200, height: 100, unit: "px" },
				background: { kind: "solid", value: "#fff" },
				root,
			},
		],
		assets: { a1: { id: "a1", uri: DATA_PNG, ...asset } },
		metadata: { createdAt: "T", updatedAt: "T" },
	};
}

async function svgFor(
	node: CanvasImageNode,
	asset: Partial<CanvasAssetRef> = {},
) {
	const document = ir(node, asset);
	const page = document.pages[0];
	if (!page) throw new Error("no page");
	return serializePageToSvg(document, page.id);
}

describe("image fitMode serialization (B-02, FR-094)", () => {
	it("absent fitMode keeps the pre-B-02 stretch behavior", async () => {
		const { svg } = await svgFor(imageNode());
		expect(svg).toContain('preserveAspectRatio="none"');
	});

	it("fill maps to slice, fit maps to meet", async () => {
		expect((await svgFor(imageNode("fill"))).svg).toContain(
			'preserveAspectRatio="xMidYMid slice"',
		);
		expect((await svgFor(imageNode("fit"))).svg).toContain(
			'preserveAspectRatio="xMidYMid meet"',
		);
	});

	it("center with intrinsic dims places the bitmap naturally, clipped to bounds", async () => {
		const { svg, warnings } = await svgFor(imageNode("center"), {
			width: 100,
			height: 40,
		});
		// (200-100)/2 = 50, (100-40)/2 = 30 — natural size, fit clip wrapper.
		expect(svg).toContain('x="50"');
		expect(svg).toContain('y="30"');
		expect(svg).toContain('width="100"');
		expect(svg).toContain('height="40"');
		expect(svg).toContain('clip-path="url(#fit-img-1)"');
		expect(warnings.map((w) => w.code)).not.toContain(
			"IMAGE_FIT_MODE_APPROXIMATED",
		);
	});

	it("original anchors at the node origin", async () => {
		const { svg } = await svgFor(imageNode("original"), {
			width: 100,
			height: 40,
		});
		expect(svg).toContain('x="0"');
		expect(svg).toContain('y="0"');
		expect(svg).toContain('clip-path="url(#fit-img-1)"');
	});

	it("original/center WITHOUT intrinsic dims approximate as fit + typed warning", async () => {
		const { svg, warnings } = await svgFor(imageNode("center"));
		expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
		expect(warnings.map((w) => w.code)).toContain(
			"IMAGE_FIT_MODE_APPROXIMATED",
		);
	});

	it("crop composes with the fit clip (both clip paths present)", async () => {
		const { svg } = await svgFor(
			imageNode("center", { x: 10, y: 10, width: 50, height: 20 }),
			{ width: 100, height: 40 },
		);
		expect(svg).toContain('clip-path="url(#fit-img-1)"');
		expect(svg).toContain('clip-path="url(#crop-img-1)"');
	});
});

describe("image adjustments serialization (C-04, FR-100)", () => {
	it("emits ONE feColorMatrix from the shared math plus feGaussianBlur", async () => {
		const node = {
			...imageNode(),
			adjustments: { grayscale: 1, blur: 8 },
		} as CanvasImageNode;
		const { svg, warnings } = await svgFor(node);
		expect(svg).toContain('filter="url(#adjust-img-1)"');
		expect(svg).toContain('<feColorMatrix type="matrix"');
		expect(svg).toContain('<feGaussianBlur stdDeviation="4" />');
		// Defined vocabulary — no "unsupported" warning for adjustments.
		expect(warnings.every((w) => w.code !== "IMAGE_FILTERS_UNSUPPORTED")).toBe(
			true,
		);
	});

	it("identity adjustments emit no filter at all", async () => {
		const node = {
			...imageNode(),
			adjustments: {},
		} as CanvasImageNode;
		const { svg } = await svgFor(node);
		expect(svg).not.toContain("filter=");
	});

	it("the legacy open-ended filters stub still warns (unchanged)", async () => {
		const node = {
			...imageNode(),
			filters: [{ kind: "mystery" }],
		} as CanvasImageNode;
		const { warnings } = await svgFor(node);
		expect(warnings.some((w) => w.code === "IMAGE_FILTERS_UNSUPPORTED")).toBe(
			true,
		);
	});
});

describe("image alt-text serialization (§12 item 11)", () => {
	it("emits a <title> + role='img' when alt is set", async () => {
		const node = { ...imageNode(), alt: "A red barn" } as CanvasImageNode;
		const { svg } = await svgFor(node);
		expect(svg).toContain("<title>A red barn</title>");
		expect(svg).toContain('role="img"');
	});

	it("keeps the self-closed <image> form when alt is absent or blank", async () => {
		// The SVG ROOT carries its own role/title (doc title), so assert on the
		// IMAGE element specifically: self-closed, no per-image <title>.
		const { svg } = await svgFor(imageNode());
		expect(svg).toContain('href="data:image/png;base64,SGk=" />');
		expect(svg).not.toContain("</image>");
		const blank = { ...imageNode(), alt: "   " } as CanvasImageNode;
		expect((await svgFor(blank)).svg).not.toContain("</image>");
	});

	it("escapes alt text (no XML injection)", async () => {
		const node = { ...imageNode(), alt: "<script>&" } as CanvasImageNode;
		const { svg } = await svgFor(node);
		expect(svg).toContain("&lt;script&gt;&amp;");
		expect(svg).not.toContain("<script>");
	});
});
