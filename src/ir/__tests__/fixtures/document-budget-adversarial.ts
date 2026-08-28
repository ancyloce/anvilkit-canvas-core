import {
	createCanvasIR,
	createComponentInstance,
	createGroup,
	createPage,
	createRect,
} from "../../builders.js";
import type {
	CanvasComponentDefinition,
	CanvasGroupNode,
	CanvasIR,
} from "../../types.js";

const FIXED_NOW = "2026-08-27T00:00:00.000Z";

function baseDocument(): CanvasIR {
	return createCanvasIR({
		id: "adversarial-document",
		title: "",
		pages: [createPage({ id: "page-0" })],
		now: () => FIXED_NOW,
	});
}

/** Builds depth iteratively so the fixture itself does not consume the stack. */
export function createDeepTreeDocument(depth: number): CanvasIR {
	let root: CanvasGroupNode = createGroup({ id: `group-${depth}` });
	for (let level = depth - 1; level >= 0; level -= 1) {
		root = createGroup({ id: `group-${level}`, children: [root] });
	}
	return createCanvasIR({
		id: "deep-tree",
		title: "",
		pages: [createPage({ id: "page-0", root })],
		now: () => FIXED_NOW,
	});
}

export function createWideContainerDocument(childCount: number): CanvasIR {
	const children = Array.from({ length: childCount }, (_, index) =>
		createRect({
			id: `rect-${index}`,
			bounds: { width: 1, height: 1 },
		}),
	);
	return createCanvasIR({
		id: "wide-container",
		title: "",
		pages: [
			createPage({
				id: "page-0",
				root: createGroup({ id: "root", children }),
			}),
		],
		now: () => FIXED_NOW,
	});
}

export function createLargeStringDocument(titleCharacters: number): CanvasIR {
	return {
		...baseDocument(),
		title: "x".repeat(titleCharacters),
	};
}

export function createRecursiveComponentDocument(): CanvasIR {
	const definition: CanvasComponentDefinition = {
		id: "recursive",
		name: "Recursive",
		revision: 1,
		root: createComponentInstance({
			id: "self",
			componentId: "recursive",
			bounds: { width: 1, height: 1 },
		}),
		properties: [],
	};
	return {
		...baseDocument(),
		components: { recursive: definition },
	};
}

export function createManyPagesDocument(pageCount: number): CanvasIR {
	return createCanvasIR({
		id: "many-pages",
		title: "",
		pages: Array.from({ length: pageCount }, (_, index) =>
			createPage({ id: `page-${index}` }),
		),
		now: () => FIXED_NOW,
	});
}

export function createManyAssetsDocument(assetCount: number): CanvasIR {
	const assets = Object.fromEntries(
		Array.from({ length: assetCount }, (_, index) => {
			const id = `asset-${index}`;
			return [id, { id, uri: `asset:${index}` }];
		}),
	);
	return { ...baseDocument(), assets };
}
