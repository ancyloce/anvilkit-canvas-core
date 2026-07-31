/**
 * @file Clipboard component-reference guard (plan 0023 M3-09, LC-DOCFLOW).
 *
 * Same-document copy/paste needs no component logic at all: paste flows
 * through the shared `regenerateNodeIds`, which rewrites ONLY `node.id`
 * (INV-9) — `componentId` references and Property-ID-keyed override maps
 * ride verbatim, and virtual ids regenerate at resolution. What P0 must add
 * is the CROSS-document guard: a paste target that lacks a referenced
 * definition must surface the choice (Cancel, or flatten before copy) and
 * never silently create a broken reference. This module is that detection —
 * the Editor owns the dialog.
 */

import type { CanvasComponentRegistry, CanvasNode } from "../ir/types.js";
import { localComponentIdOf } from "../ir/component-source.js";
import { isContainerNode } from "../ir/walkers.js";

/** One pasted-instance-to-be whose Source is absent from the target registry. */
export interface CanvasForeignComponentRef {
	instanceId: string;
	componentId: string;
}

/**
 * Instance nodes in `nodes` (a clipboard payload's roots, pre-paste) whose
 * `componentId` does not resolve in `registry`. Empty result = safe to paste
 * as-is; non-empty = the caller must cancel or flatten, per LC-DOCFLOW's
 * "never silently create a broken reference".
 */
export function findForeignComponentRefs(
	nodes: readonly CanvasNode[],
	registry: CanvasComponentRegistry | undefined,
): readonly CanvasForeignComponentRef[] {
	const refs: CanvasForeignComponentRef[] = [];
	const visit = (node: CanvasNode): void => {
		// Local Sources only. An external instance is never "foreign" to the
		// local registry — it does not belong there at all, and it travels with
		// its snapshot rather than with a definition (plan 0021 T-014).
		if (node.type === "component-instance") {
			const localId = localComponentIdOf(node.source);
			if (localId !== undefined && !registry?.[localId]) {
				refs.push({ instanceId: node.id, componentId: localId });
			}
		}
		if (isContainerNode(node)) {
			for (const child of node.children) visit(child);
		}
	};
	for (const node of nodes) visit(node);
	return refs;
}
