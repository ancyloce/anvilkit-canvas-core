import type { CanvasCommand } from "./types.js";

/**
 * Granular document-change records for `@anvilkit/canvas-core`.
 *
 * Framework-free (no React): a `CanvasChange` describes the effect of a command
 * so consumers (autosave, dirty-tracking, collaborative sync) can react without
 * diffing whole IRs. Records are best-effort and derived from the command shape;
 * `pageId` is omitted where the command does not carry it (node delete/ungroup).
 */
export type CanvasChange =
	| { kind: "added"; nodeId: string; pageId?: string }
	| { kind: "removed"; nodeId: string; pageId?: string }
	| { kind: "updated"; nodeId: string; keys: readonly string[] }
	| { kind: "transform"; nodeId: string; dx: number; dy: number; drot: number }
	| {
			kind: "page";
			pageId: string;
			op: "create" | "delete" | "rename" | "reorder";
	  };

/**
 * Derive the change record for a single command, or `null` when there is no
 * meaningful granular record (a `batch` — its sub-commands are mapped
 * individually by `applyCommands`). Pure: reads only the command.
 */
export function commandToChange(cmd: CanvasCommand): CanvasChange | null {
	switch (cmd.type) {
		case "node.create":
			return { kind: "added", nodeId: cmd.node.id, pageId: cmd.pageId };
		case "node.delete":
			return { kind: "removed", nodeId: cmd.nodeId };
		case "node.reorder":
			return { kind: "updated", nodeId: cmd.nodeId, keys: ["order"] };
		case "node.move":
			return {
				kind: "transform",
				nodeId: cmd.nodeId,
				dx: cmd.to.x - cmd.from.x,
				dy: cmd.to.y - cmd.from.y,
				drot: 0,
			};
		case "node.rotate":
			return {
				kind: "transform",
				nodeId: cmd.nodeId,
				dx: 0,
				dy: 0,
				drot: cmd.to - cmd.from,
			};
		case "node.resize":
			return {
				kind: "updated",
				nodeId: cmd.nodeId,
				keys: ["transform", "bounds"],
			};
		case "node.update":
			return {
				kind: "updated",
				nodeId: cmd.nodeId,
				keys: Object.keys(cmd.patch),
			};
		case "image.replace":
			return { kind: "updated", nodeId: cmd.nodeId, keys: ["assetId"] };
		case "node.group":
			return { kind: "added", nodeId: cmd.groupId, pageId: cmd.pageId };
		case "node.ungroup":
			return { kind: "removed", nodeId: cmd.groupId };
		case "page.create":
			return { kind: "page", pageId: cmd.page.id, op: "create" };
		case "page.delete":
			return { kind: "page", pageId: cmd.pageId, op: "delete" };
		case "page.rename":
			return { kind: "page", pageId: cmd.pageId, op: "rename" };
		case "page.reorder":
			return { kind: "page", pageId: cmd.pageId, op: "reorder" };
		case "batch":
			// Batches carry no single record; applyCommands maps each sub-command.
			return null;
	}
}

/** A subscriber for change batches. Returns an unsubscribe function. */
export interface CanvasChangeEmitter {
	emit(changes: readonly CanvasChange[]): void;
	subscribe(fn: (changes: readonly CanvasChange[]) => void): () => void;
}

/**
 * A minimal, framework-free pub/sub for change batches. Works outside React
 * (e.g. in the host's collab/autosave plugins).
 */
export function createChangeEmitter(): CanvasChangeEmitter {
	const listeners = new Set<(changes: readonly CanvasChange[]) => void>();
	return {
		emit(changes) {
			for (const fn of listeners) fn(changes);
		},
		subscribe(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		},
	};
}
