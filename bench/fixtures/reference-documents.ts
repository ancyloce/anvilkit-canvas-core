import {
	createCanvasIR,
	createGroup,
	createImage,
	createPage,
	createRect,
	createText,
} from "../../src/ir/builders.js";
import type { CanvasIR, CanvasNode } from "../../src/ir/types.js";
import { buildComponentInstances } from "./component-instances.js";

export type ExecutableReferenceDocumentId =
	| "canvas-balanced-100-v1"
	| "canvas-balanced-1000-v1"
	| "canvas-balanced-5000-v1"
	| "canvas-components-1000-v1"
	| "canvas-image-1000-v1"
	| "canvas-text-1000-v1";

const FIXED_NOW = () => "2026-08-27T00:00:00.000Z";
const FIXED_IMAGE_URI =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function position(index: number): { x: number; y: number } {
	return { x: (index % 50) * 24, y: Math.floor(index / 50) * 24 };
}

function documentWithChildren(
	id: string,
	children: readonly CanvasNode[],
): CanvasIR {
	const page = createPage({
		id: `${id}-page`,
		root: createGroup({
			id: `${id}-root`,
			bounds: { width: 1_200, height: 1_200 },
			children: [...children],
		}),
	});
	return createCanvasIR({ id, title: id, pages: [page], now: FIXED_NOW });
}

function buildBalanced(id: string, count: number): CanvasIR {
	const children = Array.from({ length: count }, (_, index) => {
		const common = {
			id: `${id}-node-${index}`,
			transform: position(index),
			bounds: { width: 20, height: 20 },
		};
		return index % 3 === 0
			? createText({ ...common, text: `Label ${index}` })
			: createRect({ ...common, fill: index % 2 === 0 ? "#2563eb" : "#f59e0b" });
	});
	return documentWithChildren(id, children);
}

function buildTextHeavy(id: string, count: number): CanvasIR {
	return documentWithChildren(
		id,
		Array.from({ length: count }, (_, index) =>
			createText({
				id: `${id}-text-${index}`,
				transform: position(index),
				bounds: { width: 120, height: 20 },
				text: `Reference text ${index % 100}`,
			}),
		),
	);
}

function buildImageHeavy(id: string, count: number): CanvasIR {
	const document = documentWithChildren(
		id,
		Array.from({ length: count }, (_, index) =>
			createImage({
				id: `${id}-image-${index}`,
				transform: position(index),
				bounds: { width: 20, height: 20 },
				assetId: "reference-image",
				alt: `Reference image ${index}`,
			}),
		),
	);
	return {
		...document,
		assets: {
			"reference-image": {
				id: "reference-image",
				uri: FIXED_IMAGE_URI,
			},
		},
	};
}

/** Build a fresh deterministic representative document by stable fixture ID. */
export function buildReferenceDocument(
	id: ExecutableReferenceDocumentId,
): CanvasIR {
	switch (id) {
		case "canvas-balanced-100-v1":
			return buildBalanced(id, 100);
		case "canvas-balanced-1000-v1":
			return buildBalanced(id, 1_000);
		case "canvas-balanced-5000-v1":
			return buildBalanced(id, 5_000);
		case "canvas-text-1000-v1":
			return buildTextHeavy(id, 1_000);
		case "canvas-image-1000-v1":
			return buildImageHeavy(id, 1_000);
		case "canvas-components-1000-v1":
			return buildComponentInstances(1_000);
	}
}
