import { z } from "zod";
import type { CanvasIR } from "./ir/types.js";
import { findNode } from "./ir/walkers.js";

/**
 * Headless comment anchor contract (FR-072).
 *
 * Comments (thread, author, body, replies) are stored OUTSIDE Canvas IR and
 * outside canvas-core by default — core is React/DOM-free and has no concept
 * of a comment thread or platform storage. This module defines only what a
 * comment attaches TO: a stable, serializable, versioned reference that an
 * external comment-storage system keys its threads on.
 */

export interface CanvasCommentPageAnchor {
	kind: "page";
	version: string;
	pageId: string;
}

export interface CanvasCommentNodeAnchor {
	kind: "node";
	version: string;
	pageId: string;
	nodeId: string;
}

export interface CanvasCommentCoordinateAnchor {
	kind: "coordinate";
	version: string;
	pageId: string;
	x: number;
	y: number;
}

/**
 * Anchors a comment to a set of nodes rather than a fixed rectangle, so the
 * anchor survives every node in the set moving — the region is always
 * whatever the current bounds of `nodeIds` are, recomputed by the consumer,
 * never a stale snapshot core would need to keep in sync.
 */
export interface CanvasCommentSelectionAnchor {
	kind: "selection";
	version: string;
	pageId: string;
	nodeIds: readonly string[];
}

export type CanvasCommentAnchor =
	| CanvasCommentPageAnchor
	| CanvasCommentNodeAnchor
	| CanvasCommentCoordinateAnchor
	| CanvasCommentSelectionAnchor;

const CanvasCommentAnchorBaseShape = {
	version: z.string().min(1),
	pageId: z.string().min(1),
} as const;

export const CanvasCommentPageAnchorSchema = z.looseObject({
	...CanvasCommentAnchorBaseShape,
	kind: z.literal("page"),
});

export const CanvasCommentNodeAnchorSchema = z.looseObject({
	...CanvasCommentAnchorBaseShape,
	kind: z.literal("node"),
	nodeId: z.string().min(1),
});

export const CanvasCommentCoordinateAnchorSchema = z.looseObject({
	...CanvasCommentAnchorBaseShape,
	kind: z.literal("coordinate"),
	x: z.number(),
	y: z.number(),
});

export const CanvasCommentSelectionAnchorSchema = z.looseObject({
	...CanvasCommentAnchorBaseShape,
	kind: z.literal("selection"),
	nodeIds: z.array(z.string().min(1)),
});

/** A discriminated union over the four anchor kinds (FR-072), dispatched on `kind`. */
export const CanvasCommentAnchorSchema: z.ZodType<CanvasCommentAnchor> =
	z.discriminatedUnion("kind", [
		CanvasCommentPageAnchorSchema,
		CanvasCommentNodeAnchorSchema,
		CanvasCommentCoordinateAnchorSchema,
		CanvasCommentSelectionAnchorSchema,
	]);

export type CanvasCommentAnchorStatus = "active" | "archived";

export interface CanvasCommentAnchorResolution {
	status: CanvasCommentAnchorStatus;
	/** Present only when `status: "archived"`. */
	reason?: "page-deleted" | "node-deleted";
	/**
	 * `selection` anchors only: ids from `nodeIds` that no longer exist, even
	 * while the anchor as a whole is still `"active"` (at least one survives).
	 */
	missingNodeIds?: readonly string[];
}

/**
 * Resolve whether an anchor's target still exists in `ir`. Never throws — a
 * missing target resolves to `"archived"` with a `reason`, never a thrown
 * error or a silently dangling reference, so a comment UI can always render
 * *something* for a stale anchor instead of crashing.
 *
 * Node-clone rule (explicit, per FR-072): anchors are keyed by a node's OWN
 * id and are never migrated onto a clone. However a host duplicates a node
 * (e.g. `node.create` with a freshly generated id copying the source's
 * props), the copy is a distinct node with its own id — an anchor on the
 * source keeps pointing at the source; the clone starts with no anchors of
 * its own. Only the SOURCE node's own removal archives the anchor; a clone
 * existing, or later being deleted itself, has no effect on an anchor that
 * was never pointed at it.
 */
export function resolveCommentAnchor(
	anchor: CanvasCommentAnchor,
	ir: CanvasIR,
): CanvasCommentAnchorResolution {
	const pageExists = ir.pages.some((page) => page.id === anchor.pageId);
	if (!pageExists) return { status: "archived", reason: "page-deleted" };

	switch (anchor.kind) {
		case "page":
			return { status: "active" };
		case "coordinate":
			return { status: "active" };
		case "node":
			return findNode(ir, anchor.nodeId)
				? { status: "active" }
				: { status: "archived", reason: "node-deleted" };
		case "selection": {
			if (anchor.nodeIds.length === 0) return { status: "active" };
			const missingNodeIds = anchor.nodeIds.filter(
				(id) => findNode(ir, id) === null,
			);
			if (missingNodeIds.length === anchor.nodeIds.length) {
				return { status: "archived", reason: "node-deleted" };
			}
			return missingNodeIds.length > 0
				? { status: "active", missingNodeIds }
				: { status: "active" };
		}
	}
}
