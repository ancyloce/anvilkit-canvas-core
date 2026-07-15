import type { CanvasNode } from "./types.js";
import {
	CanvasIRDepthError,
	isContainerNode,
	MAX_TREE_DEPTH,
} from "./walkers.js";

export interface RegenerateNodeIdsOptions {
	/**
	 * Fresh-id source (default `crypto.randomUUID`). Inject a deterministic
	 * factory for reproducible output — ids are assigned in pre-order (parent
	 * before children, children in document order), the same visitation order
	 * as {@link walkPage}.
	 */
	idFactory?: () => string;
}

export interface RegenerateNodeIdsResult<T extends CanvasNode = CanvasNode> {
	/** The remapped deep copy. The input node is never mutated. */
	node: T;
	/** old id → new id, one entry per node in the subtree. */
	idMap: ReadonlyMap<string, string>;
}

function defaultIdFactory(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function remap(
	node: CanvasNode,
	idFactory: () => string,
	idMap: Map<string, string>,
	depth: number,
	idChain: string[],
): void {
	if (depth > MAX_TREE_DEPTH) {
		throw new CanvasIRDepthError([...idChain, node.id]);
	}
	const newId = idFactory();
	idMap.set(node.id, newId);
	node.id = newId;
	if (isContainerNode(node)) {
		idChain.push(node.id);
		for (const child of node.children) {
			remap(child, idFactory, idMap, depth + 1, idChain);
		}
		idChain.pop();
	}
}

/**
 * Deep-copy a node subtree and give every node a brand-new id, preserving
 * hierarchy, order, and every other field (M0-05, PRD 0012 §9.2). This is THE
 * shared id-regeneration primitive behind duplicate, paste, page cloning, and
 * template instantiation — do not hand-roll another remap loop.
 *
 * - Non-mutating: the input subtree is `structuredClone`d first.
 * - Pre-order assignment with the same {@link MAX_TREE_DEPTH} guard as the
 *   walkers ({@link CanvasIRDepthError} on hostile depth).
 * - Returns the old→new {@link RegenerateNodeIdsResult.idMap} so callers can
 *   translate external references (locked-id lists, selections, asset keys).
 */
export function regenerateNodeIds<T extends CanvasNode>(
	node: T,
	options: RegenerateNodeIdsOptions = {},
): RegenerateNodeIdsResult<T> {
	const idFactory = options.idFactory ?? defaultIdFactory;
	const cloned = structuredClone(node);
	const idMap = new Map<string, string>();
	remap(cloned, idFactory, idMap, 0, []);
	return { node: cloned, idMap };
}
