import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serializePageToSvg } from "../serialize/svg.js";
import type { CanvasIR, CanvasTransform } from "../types.js";

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
	version: "1",
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
