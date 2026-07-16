import { resolveNow } from "../clock.js";
import type { CanvasIR } from "../ir/types.js";
import { pageOf } from "../ir/walkers.js";
import { applyCommand } from "./runtime.js";
import type { CanvasCommand, CommandApplyOptions } from "./types.js";

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
			op:
				| "create"
				| "delete"
				| "rename"
				| "reorder"
				| "resize"
				| "background"
				| "layout-aids";
	  }
	| { kind: "asset"; assetId: string; op: "put" | "remove" };

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
		case "node.reparent":
			return { kind: "updated", nodeId: cmd.nodeId, keys: ["parent", "order"] };
		case "asset.put":
			return { kind: "asset", assetId: cmd.asset.id, op: "put" };
		case "asset.remove":
			return { kind: "asset", assetId: cmd.assetId, op: "remove" };
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
		case "node.applyStyle":
			return {
				kind: "updated",
				nodeId: cmd.nodeId,
				keys: Object.keys(cmd.style),
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
		case "page.resize":
			return { kind: "page", pageId: cmd.pageId, op: "resize" };
		case "page.set-background":
			return { kind: "page", pageId: cmd.pageId, op: "background" };
		case "page.set-layout-aids":
			return { kind: "page", pageId: cmd.pageId, op: "layout-aids" };
		case "page.reorder":
			return { kind: "page", pageId: cmd.pageId, op: "reorder" };
		case "batch":
			// Batches carry no single record; applyCommands maps each sub-command.
			return null;
	}
}

/** Who produced a {@link CanvasChangeRecord}: applied locally, or received from a remote peer/server. */
export type CanvasChangeSource = "local" | "remote";

/**
 * An enriched, persistable, replayable record of one applied command (FR-070).
 * Additive alongside {@link CanvasChange}: `change` carries the existing
 * best-effort content diff, `command` carries the original command so a
 * sequence of records can be replayed deterministically via {@link replayChanges}.
 */
export interface CanvasChangeRecord {
	/** Unique id for this record, stable across persistence/transmission. */
	commandId: string;
	/** Who applied the command. Defaults to `"local"` when not supplied. */
	actorId: string;
	/** ISO-8601 timestamp, from the same clock seam as command apply options. */
	timestamp: string;
	/**
	 * The page the command targeted — resolved even for commands whose type
	 * omits it. Absent for DOCUMENT-level changes (`kind: "asset"`), which
	 * target no page.
	 */
	pageId?: string;
	/** Node ids the command affected. Empty for page- and asset-kind changes. */
	nodeIds: readonly string[];
	/** `"remote"` records may bypass a host's local undo stack. */
	source: CanvasChangeSource;
	/** Ordering/version metadata for conflict resolution. Defaults to `0`. */
	sequence: number;
	/** The original command, enabling deterministic replay. */
	command: CanvasCommand;
	/** The derived content diff (identical to what `commandToChange` would return). */
	change: CanvasChange;
}

export interface ChangeRecordOptions extends CommandApplyOptions {
	actorId?: string;
	source?: CanvasChangeSource;
	sequence?: number;
	commandId?: string;
	/** Injectable id factory for `commandId` when not supplied. Defaults to `crypto.randomUUID`. */
	commandIdFactory?: () => string;
}

function resolveChangeNodeIds(change: CanvasChange): readonly string[] {
	return change.kind === "page" || change.kind === "asset"
		? []
		: [change.nodeId];
}

/**
 * Resolve the page a change targets, backfilling via IR lookup for the
 * command types that don't carry `pageId` directly (delete, ungroup, move,
 * resize, rotate, reorder, update, image.replace). `ir` must be the
 * pre-mutation IR — the node (or, for `removed`, its still-present record)
 * must exist in it for the lookup to succeed.
 */
function resolveChangePageId(
	change: CanvasChange,
	ir: CanvasIR,
): string | undefined {
	if (change.kind === "asset") return undefined; // document-level
	if (change.kind === "page") return change.pageId;
	if (
		(change.kind === "added" || change.kind === "removed") &&
		change.pageId !== undefined
	) {
		return change.pageId;
	}
	const page = pageOf(ir, change.nodeId);
	if (!page) {
		throw new Error(
			`commandToChangeRecord: could not resolve a containing page for node "${change.nodeId}".`,
		);
	}
	return page.id;
}

/**
 * Enrich a single command into a full {@link CanvasChangeRecord}, or `null`
 * for a `batch` (mirrors `commandToChange`; `applyCommands` maps sub-commands
 * individually). `ir` must be the pre-mutation IR so page/node lookups for
 * commands that omit `pageId` can resolve correctly.
 */
export function commandToChangeRecord(
	cmd: CanvasCommand,
	ir: CanvasIR,
	options: ChangeRecordOptions = {},
): CanvasChangeRecord | null {
	const change = commandToChange(cmd);
	if (change === null) return null;
	const pageId = resolveChangePageId(change, ir);
	return {
		commandId:
			options.commandId ??
			(options.commandIdFactory ?? (() => crypto.randomUUID()))(),
		actorId: options.actorId ?? "local",
		timestamp: resolveNow(options.now)(),
		...(pageId !== undefined ? { pageId } : {}),
		nodeIds: resolveChangeNodeIds(change),
		source: options.source ?? "local",
		sequence: options.sequence ?? 0,
		command: cmd,
		change,
	};
}

/**
 * Deterministically replay a sequence of change records onto an initial IR by
 * re-applying each record's original `command` in order via `applyCommand`.
 * Ignores each command's own inverse; only the resulting `ir` is threaded.
 */
export function replayChanges(
	initialIr: CanvasIR,
	records: readonly CanvasChangeRecord[],
	options: CommandApplyOptions = {},
): CanvasIR {
	return records.reduce(
		(ir, record) => applyCommand(ir, record.command, options).ir,
		initialIr,
	);
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
