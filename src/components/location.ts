/**
 * @file Scoped tree access over a document location (plan 0023 M3-01,
 * LC-CMD). One interface answers "which tree does this operation target?"
 * for BOTH page trees and Component Source trees, so the command layer
 * never forks per scope — the write methods delegate to the SAME
 * `ir/mutations.ts` engine pages use, with the mutation's `location` set.
 * Rank 2: reads `ir/` only.
 */

import { replaceChildrenInParent, replaceNode } from "../ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../ir/types.js";
import type {
	CanvasDocumentLocation,
	FindNodeInSubtreeResult,
} from "../ir/walkers.js";
import { findNodeInSubtree } from "../ir/walkers.js";

export type { CanvasDocumentLocation };

export interface TreeAccessWriteOptions {
	now?: () => string;
}

/**
 * Read/write access to ONE node tree — a page's or a Component Source's.
 *
 * `getRoot`/`findNode` return `undefined` when the location (or node) does
 * not exist; the write methods instead throw a typed
 * `CanvasIRMutationError` (`location-not-found`), because a silently
 * dropped write would hide a real defect. Writes return the next document
 * — access objects are snapshots, so create a fresh one per document value.
 */
export interface CanvasTreeAccess {
	readonly location: CanvasDocumentLocation;
	/** The scope's root node — `undefined` when the page/definition is absent. */
	getRoot(): CanvasNode | undefined;
	/** Find a node (with its in-scope parent) within this tree only. */
	findNode(id: string): FindNodeInSubtreeResult | undefined;
	/**
	 * Replace the subtree rooted at `id` with `node` (id/kind may change) at
	 * the exact same position. See `ir/mutations.ts` `replaceNode`.
	 */
	replaceNode(
		id: string,
		node: CanvasNode,
		options?: TreeAccessWriteOptions,
	): CanvasIR;
	/** Rewrite one container's children in a single immutable pass. */
	updateChildren(
		parentId: string,
		replace: (children: readonly CanvasNode[]) => CanvasNode[],
		options?: TreeAccessWriteOptions,
	): CanvasIR;
}

export function createTreeAccess(
	ir: CanvasIR,
	location: CanvasDocumentLocation,
): CanvasTreeAccess {
	const getRoot = (): CanvasNode | undefined =>
		location.kind === "page"
			? ir.pages.find((page) => page.id === location.id)?.root
			: ir.components?.[location.id]?.root;
	return {
		location,
		getRoot,
		findNode: (id) => {
			const root = getRoot();
			return root ? (findNodeInSubtree(root, id) ?? undefined) : undefined;
		},
		replaceNode: (id, node, options) =>
			replaceNode(ir, { id, node, location, now: options?.now }),
		updateChildren: (parentId, replace, options) =>
			replaceChildrenInParent(ir, {
				parentId,
				replace,
				location,
				now: options?.now,
			}),
	};
}
