import type {
	CanvasContainerNode,
	CanvasFrameNode,
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

/**
 * The kinds that hold `children`. This is the single source of truth for "should
 * I recurse into this node" across walkers, mutations, and serializers.
 *
 * It is a static set rather than a lookup through a runtime's
 * `CanvasNodeKindRegistry` (whose `CanvasNodeKindDefinition.isContainer` carries
 * the same fact) for two reasons: the walkers and mutations here are pure
 * functions with no runtime handle, and threading a registry through every one of
 * them would widen their signatures for no gain; and a static set gives real type
 * narrowing to `CanvasContainerNode`, which a registry lookup cannot. The two are
 * kept honest by a parity test asserting this set equals the built-in kind defs
 * flagged `isContainer`. An extension kind that declares `isContainer` is walked
 * by the runtime, not by these built-in-typed helpers.
 */
const CONTAINER_KINDS: ReadonlySet<CanvasNodeKind> = new Set([
	"group",
	"frame",
] satisfies CanvasContainerNode["type"][]);

/** True for any node that holds `children` — currently `group` and `frame`. */
export function isContainerNode(node: CanvasNode): node is CanvasContainerNode {
	return CONTAINER_KINDS.has(node.type);
}

/**
 * True only for a literal `group`. Prefer {@link isContainerNode} when the
 * question is "does this node have children"; use this one only when the
 * behaviour is specific to groups (e.g. ungrouping, which a frame does not
 * support).
 */
export function isGroupNode(node: CanvasNode): node is CanvasGroupNode {
	return node.type === "group";
}

/** True only for a literal `frame`. */
export function isFrameNode(node: CanvasNode): node is CanvasFrameNode {
	return node.type === "frame";
}

export function isLeafNode(node: CanvasNode): node is CanvasLeafNode {
	return !isContainerNode(node);
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
	if (isContainerNode(node)) {
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
	/** Any container — a `group` or, since frames landed, a `frame`. */
	parent: CanvasContainerNode;
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

function parentOfInPage(page: CanvasPage, id: string): ParentOfResult | null {
	let result: ParentOfResult | null = null;
	walkPage(page, ({ node }) => {
		if (result) return;
		if (isContainerNode(node)) {
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
