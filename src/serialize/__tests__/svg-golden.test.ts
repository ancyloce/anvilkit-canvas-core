import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CanvasIR, CanvasTransform } from "../ir/types.js";
import { serializePageToSvg } from "../serialize/svg.js";

/**
 * Dependency-free well-formedness check: scans tags and verifies every open
 * tag is balanced by a matching close. Safe because the serializer escapes all
 * `<`/`>` in text and attribute content, so no raw angle brackets appear inside
 * values to confuse the scanner.
 */
function assertWellFormed(svg: string): void {
	const stack: string[] = [];
	const tagRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
	for (const match of svg.matchAll(tagRe)) {
		const closing = match[1] === "/";
		const name = match[2];
		const selfClosing = match[4] === "/";
		if (closing) {
			expect(stack.pop()).toBe(name);
		} else if (!selfClosing) {
			stack.push(name);
		}
	}
	expect(stack).toEqual([]);
}

function t(x = 0, y = 0): CanvasTransform {
	return { x, y, rotation: 0, scaleX: 1, scaleY: 1 };
}

const fixture: CanvasIR = {
	version: "2",
	id: "doc-golden",
	title: "Golden",
	pages: [
		{
			id: "p1",
			size: { width: 240, height: 160, unit: "px" },
			background: { kind: "solid", value: "#0f172a" },
			root: {
				id: "root",
				type: "group",
				transform: t(),
				bounds: { width: 240, height: 160 },
				zIndex: 0,
				children: [
					{
						id: "panel",
						type: "rect",
						transform: t(16, 16),
						bounds: { width: 120, height: 60 },
						zIndex: 0,
						fill: "#1e293b",
						stroke: "#38bdf8",
						strokeWidth: 2,
						radius: 8,
					},
					{
						id: "dot",
						type: "ellipse",
						transform: t(176, 24),
						bounds: { width: 40, height: 40 },
						zIndex: 1,
						fill: "#f472b6",
					},
					{
						id: "rule",
						type: "line",
						transform: t(16, 96),
						bounds: { width: 0, height: 0 },
						zIndex: 2,
						points: [0, 0, 208, 0],
						stroke: "#475569",
						strokeWidth: 1,
					},
					{
						id: "title",
						type: "text",
						transform: t(16, 108),
						bounds: { width: 208, height: 32 },
						zIndex: 3,
						text: "Canvas → SVG",
						fontFamily: "Inter",
						fontSize: 24,
						fontWeight: "600",
						fill: "#e2e8f0",
						align: "left",
					},
					{
						id: "logo-group",
						type: "group",
						transform: t(140, 28),
						bounds: { width: 0, height: 0 },
						zIndex: 4,
						opacity: 0.9,
						children: [
							{
								id: "logo",
								type: "image",
								transform: t(),
								bounds: { width: 28, height: 28 },
								zIndex: 0,
								assetId: "logo-asset",
							},
						],
					},
				],
			},
		},
	],
	assets: {
		"logo-asset": {
			id: "logo-asset",
			uri: "https://cdn.example.com/logo.png",
			mimeType: "image/png",
			width: 28,
			height: 28,
		},
	},
	metadata: {
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	},
};

describe("serializePageToSvg golden", () => {
	it("renders a multi-node page to a stable, well-formed SVG", async () => {
		const { svg, warnings } = await serializePageToSvg(fixture, 0, {
			pretty: true,
			fonts: [
				{
					family: "Inter",
					src: 'url(/fonts/inter-var.woff2) format("woff2-variations")',
					weight: "100 900",
				},
			],
		});

		expect(warnings).toEqual([]);
		assertWellFormed(svg);
		await expect(svg).toMatchFileSnapshot(
			fileURLToPath(
				new URL("./__snapshots__/canvas-page.snap.svg", import.meta.url),
			),
		);
	});
});

// 1×1 transparent PNG — a `data:` URI so `images: "embed"` needs no fetcher.
const PIXEL_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * Golden fixture for the rich-fill features (canvas-m0-010): linear + radial
 * gradients as `<defs>`, shadows as `<feDropShadow>` filters, and an image in
 * both reference and embed modes. `fills.test.ts` asserts the structure;
 * these snapshots pin the exact bytes so serializer drift fails loudly.
 */
const fillsFixture: CanvasIR = {
	version: "2",
	id: "doc-golden-fills",
	title: "Golden fills",
	pages: [
		{
			id: "p1",
			size: { width: 240, height: 200, unit: "px" },
			background: { kind: "solid", value: "#ffffff" },
			root: {
				id: "root",
				type: "group",
				transform: t(),
				bounds: { width: 240, height: 200 },
				zIndex: 0,
				children: [
					{
						id: "linear",
						type: "rect",
						transform: t(8, 8),
						bounds: { width: 100, height: 48 },
						zIndex: 0,
						fill: {
							kind: "linear",
							stops: [
								{ offset: 0, color: "#0ea5e9" },
								{ offset: 1, color: "#8b5cf6" },
							],
							from: { x: 0, y: 0 },
							to: { x: 1, y: 1 },
						},
					},
					{
						id: "radial",
						type: "ellipse",
						transform: t(128, 8),
						bounds: { width: 48, height: 48 },
						zIndex: 1,
						fill: {
							kind: "radial",
							stops: [
								{ offset: 0, color: "#fde047" },
								{ offset: 1, color: "#f97316" },
							],
							from: { x: 0.5, y: 0.5 },
							to: { x: 1, y: 1 },
						},
					},
					{
						id: "shadowed",
						type: "rect",
						transform: t(8, 72),
						bounds: { width: 100, height: 40 },
						zIndex: 2,
						fill: "#e2e8f0",
						shadow: {
							color: "#0f172a",
							blur: 8,
							offsetX: 2,
							offsetY: 4,
							opacity: 0.5,
						},
					},
					{
						id: "ref-image",
						type: "image",
						transform: t(128, 72),
						bounds: { width: 40, height: 40 },
						zIndex: 3,
						assetId: "remote-asset",
					},
					{
						id: "embed-image",
						type: "image",
						transform: t(8, 132),
						bounds: { width: 40, height: 40 },
						zIndex: 4,
						assetId: "pixel-asset",
					},
				],
			},
		},
	],
	assets: {
		"remote-asset": {
			id: "remote-asset",
			uri: "https://cdn.example.com/photo.png",
			mimeType: "image/png",
			width: 40,
			height: 40,
		},
		"pixel-asset": {
			id: "pixel-asset",
			uri: PIXEL_PNG,
			mimeType: "image/png",
			width: 1,
			height: 1,
		},
	},
	metadata: {
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	},
};

describe("serializePageToSvg golden — gradients, shadows, image modes", () => {
	it("pins gradient <defs>, shadow filters, and referenced images (reference mode)", async () => {
		const { svg, warnings } = await serializePageToSvg(fillsFixture, 0, {
			pretty: true,
			images: "reference",
		});

		expect(warnings).toEqual([]);
		assertWellFormed(svg);
		expect(svg).toContain("<linearGradient");
		expect(svg).toContain("<radialGradient");
		expect(svg).toContain("feDropShadow");
		await expect(svg).toMatchFileSnapshot(
			fileURLToPath(
				new URL("./__snapshots__/canvas-fills.snap.svg", import.meta.url),
			),
		);
	});

	it("pins data-URI embedding (embed mode, no fetcher required)", async () => {
		const { svg, warnings } = await serializePageToSvg(fillsFixture, 0, {
			pretty: true,
			images: "embed",
		});

		// The remote asset cannot be embedded without a fetcher and must degrade
		// to a structured warning, never a throw.
		expect(warnings.map((w) => w.code)).toContain("EMBED_NO_FETCHER");
		assertWellFormed(svg);
		await expect(svg).toMatchFileSnapshot(
			fileURLToPath(
				new URL("./__snapshots__/canvas-fills-embed.snap.svg", import.meta.url),
			),
		);
	});
});
