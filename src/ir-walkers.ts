import type {
	CanvasGroupNode,
	CanvasIR,
	CanvasLeafNode,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
} from "./types.js";

export const MAX_TREE_DEPTH = 64;

export class CanvasIRDepthError extends Error {
	readonly idChain: readonly string[];

	constructor(idChain: readonly string[]) {
		super(
			`CanvasIR depth exceeded MAX_TREE_DEPTH=${MAX_TREE_DEPTH} (chain: ${idChain.join(" > ")})`,
		);
		this.name = "CanvasIRDepthError";
		this.idChain = idChain;
	}
}

export function isGroupNode(node: CanvasNode): node is CanvasGroupNode {
	return node.type === "group";
}

export function isLeafNode(node: CanvasNode): node is CanvasLeafNode {
	return node.type !== "group";
}

export function isNodeOfKind<K extends CanvasNodeKind>(
	node: CanvasNode,
	kind: K,
): node is CanvasNodeByKind<K> {
	return node.type === kind;
}

export interface WalkContext {
	node: CanvasNode;
	page: CanvasPage;
	parent: CanvasNode | null;
	depth: number;
}

export type WalkVisitor = (ctx: WalkContext) => void;

export function walkPage(page: CanvasPage, visit: WalkVisitor): void {
	walkSubtree(page.root, page, null, 0, [], visit);
}

export function walk(ir: CanvasIR, visit: WalkVisitor): void {
	for (const page of ir.pages) {
		walkPage(page, visit);
	}
}

function walkSubtree(
	node: CanvasNode,
	page: CanvasPage,
	parent: CanvasNode | null,
	depth: number,
	idChain: string[],
	visit: WalkVisitor,
): void {
	if (depth > MAX_TREE_DEPTH) {
		throw new CanvasIRDepthError([...idChain, node.id]);
	}
	visit({ node, page, parent, depth });
	if (isGroupNode(node)) {
		idChain.push(node.id);
		for (const child of node.children) {
			walkSubtree(child, page, node, depth + 1, idChain, visit);
		}
		idChain.pop();
	}
}

export interface FindNodeResult {
	node: CanvasNode;
	page: CanvasPage;
}

export function findNode(ir: CanvasIR, id: string): FindNodeResult | null {
	for (const page of ir.pages) {
		const found = findNodeInPage(page, id);
		if (found) return found;
	}
	return null;
}

function findNodeInPage(page: CanvasPage, id: string): FindNodeResult | null {
	let result: FindNodeResult | null = null;
	walkPage(page, ({ node }) => {
		if (result) return;
		if (node.id === id) {
			result = { node, page };
		}
	});
	return result;
}

export interface ParentOfResult {
	parent: CanvasGroupNode;
	page: CanvasPage;
}

export function parentOf(ir: CanvasIR, id: string): ParentOfResult | null {
	for (const page of ir.pages) {
		if (page.root.id === id) {
			// Page-root group has no parent within the IR.
			return null;
		}
		const result = parentOfInPage(page, id);
		if (result) return result;
	}
	return null;
}

function parentOfInPage(
	page: CanvasPage,
	id: string,
): ParentOfResult | null {
	let result: ParentOfResult | null = null;
	walkPage(page, ({ node }) => {
		if (result) return;
		if (isGroupNode(node)) {
			for (const child of node.children) {
				if (child.id === id) {
					result = { parent: node, page };
					return;
				}
			}
		}
	});
	return result;
}

export function pageOf(ir: CanvasIR, id: string): CanvasPage | null {
	const found = findNode(ir, id);
	return found ? found.page : null;
}
