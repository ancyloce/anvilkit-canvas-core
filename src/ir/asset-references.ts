import type {
	CanvasComponentOverrideMap,
	CanvasContainerNode,
	CanvasIR,
	CanvasNode,
} from "./types.js";

function replaceOverrides(
	overrides: CanvasComponentOverrideMap | undefined,
	fromAssetId: string,
	toAssetId: string,
): CanvasComponentOverrideMap | undefined {
	if (!overrides) return overrides;
	let changed = false;
	const next: Record<string, CanvasComponentOverrideMap[string]> = {};
	for (const [propertyId, override] of Object.entries(overrides)) {
		if (override.kind === "image" && override.assetId === fromAssetId) {
			next[propertyId] = { ...override, assetId: toAssetId };
			changed = true;
		} else {
			next[propertyId] = override;
		}
	}
	return changed ? next : overrides;
}

function replaceChildren(
	node: CanvasContainerNode,
	fromAssetId: string,
	toAssetId: string,
): CanvasNode[] | undefined {
	let changed = false;
	const children = node.children.map((child) => {
		const next = replaceNodeAssetReferences(child, fromAssetId, toAssetId);
		if (next !== child) changed = true;
		return next;
	});
	return changed ? children : undefined;
}

function replaceNodeAssetReferences(
	node: CanvasNode,
	fromAssetId: string,
	toAssetId: string,
): CanvasNode {
	switch (node.type) {
		case "image": {
			const assetId = node.assetId === fromAssetId ? toAssetId : node.assetId;
			const maskAssetId =
				node.maskAssetId === fromAssetId ? toAssetId : node.maskAssetId;
			return assetId !== node.assetId || maskAssetId !== node.maskAssetId
				? { ...node, assetId, ...(maskAssetId ? { maskAssetId } : {}) }
				: node;
		}
		case "svg":
		case "audio":
			return node.assetId === fromAssetId
				? { ...node, assetId: toAssetId }
				: node;
		case "video": {
			const assetId = node.assetId === fromAssetId ? toAssetId : node.assetId;
			const poster = node.poster === fromAssetId ? toAssetId : node.poster;
			return assetId !== node.assetId || poster !== node.poster
				? { ...node, assetId, ...(poster ? { poster } : {}) }
				: node;
		}
		case "frame": {
			const children = replaceChildren(node, fromAssetId, toAssetId);
			const placeholder = node.placeholder;
			const nextPlaceholder =
				placeholder?.assetId === fromAssetId
					? { ...placeholder, assetId: toAssetId }
					: placeholder;
			return children || nextPlaceholder !== placeholder
				? {
						...node,
						...(children ? { children } : {}),
						...(nextPlaceholder ? { placeholder: nextPlaceholder } : {}),
					}
				: node;
		}
		case "group": {
			const children = replaceChildren(node, fromAssetId, toAssetId);
			return children ? { ...node, children } : node;
		}
		case "component-instance": {
			const overrides = replaceOverrides(
				node.overrides,
				fromAssetId,
				toAssetId,
			);
			return overrides !== node.overrides ? { ...node, overrides } : node;
		}
		default:
			return node;
	}
}

/**
 * Replace one document asset id in every reference field counted by the IR
 * invariants: page and Component Source trees, masks, frame placeholders,
 * media posters, and component-instance image overrides.
 */
export function replaceDocumentAssetReferences(
	ir: CanvasIR,
	fromAssetId: string,
	toAssetId: string,
): CanvasIR {
	if (fromAssetId === toAssetId) return ir;
	let pagesChanged = false;
	const pages = ir.pages.map((page) => {
		// The rewriter never changes a node discriminant; page roots therefore
		// remain groups even though the shared recursive helper returns CanvasNode.
		const root = replaceNodeAssetReferences(
			page.root,
			fromAssetId,
			toAssetId,
		) as typeof page.root;
		if (root === page.root) return page;
		pagesChanged = true;
		return { ...page, root };
	});

	let componentsChanged = false;
	let components = ir.components;
	if (components) {
		const next = { ...components };
		for (const [componentId, definition] of Object.entries(components)) {
			if (!definition) continue;
			const root = replaceNodeAssetReferences(
				definition.root,
				fromAssetId,
				toAssetId,
			);
			if (root === definition.root) continue;
			next[componentId] = { ...definition, root };
			componentsChanged = true;
		}
		if (componentsChanged) components = next;
	}

	if (!pagesChanged && !componentsChanged) return ir;
	return {
		...ir,
		...(pagesChanged ? { pages } : {}),
		...(componentsChanged ? { components } : {}),
	};
}
