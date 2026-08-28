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
/**
 * What happened to a Component Source (plan 0023 M3-03). `source-edit` is
 * any location-scoped node command inside the Source tree; the named ops map
 * 1:1 onto the registry commands. Instance-side edits (inserting an
 * instance, setting/resetting overrides) are ordinary NODE changes on the
 * instance node (`updated` with `keys: ["overrides"]`, `added`, `removed`)
 * and deliberately do NOT use this kind. Virtual (resolved) node ids never
 * appear as change targets.
 */
export type CanvasComponentChangeOp =
	| "create"
	| "rename"
	| "duplicate"
	| "delete"
	| "add-property"
	| "update-property"
	| "remove-property"
	| "source-edit";

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
				| "layout-aids"
				| "duplicate";
	  }
	| { kind: "asset"; assetId: string; op: "put" | "remove" }
	| {
			kind: "asset";
			assetId: string;
			op: "migrate";
			toAssetId: string;
	  }
	| {
			kind: "component";
			componentId: string;
			op: CanvasComponentChangeOp;
			/** The Source revision the command wrote, when the command carries it. */
			revision?: number;
	  };

/**
 * Derive the change record for a single command, or `null` when there is no
 * meaningful granular record (a `batch` — its sub-commands are mapped
 * individually by `applyCommands`). Pure: reads only the command.
 */
export function commandToChange(cmd: CanvasCommand): CanvasChange | null {
	// A node command scoped INSIDE a Component Source tree is a Source edit:
	// consumers react at the component level (re-resolve dependents), not to
	// the individual Source node — those ids are meaningless outside the
	// definition. Page-scoped locations keep their ordinary node records.
	const sourceEdit = componentSourceChange(cmd);
	if (sourceEdit) return sourceEdit;
	switch (cmd.type) {
		case "node.create":
			return {
				kind: "added",
				nodeId: cmd.node.id,
				// A page-scoped create may carry the page in `location` instead of
				// `pageId`; the created node does not exist pre-mutation, so the
				// record enricher cannot backfill this by IR lookup.
				pageId:
					cmd.pageId ??
					(cmd.location?.kind === "page" ? cmd.location.id : undefined),
			};
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
		case "asset.migrate":
			return {
				kind: "asset",
				assetId: cmd.fromAssetId,
				op: "migrate",
				toAssetId: cmd.asset.id,
			};
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
			return {
				kind: "added",
				nodeId: cmd.groupId,
				pageId:
					cmd.pageId ??
					(cmd.location?.kind === "page" ? cmd.location.id : undefined),
			};
		case "node.ungroup":
			return { kind: "removed", nodeId: cmd.groupId };
		// Layout writes map onto the EXISTING `updated`/`added` kinds — no new
		// `CanvasChange` kind is introduced, so `commandToChangeRecord` and
		// `replayChanges` keep working unchanged.
		//
		// The derived record is deliberately LOSSY for the two composite
		// commands: `CanvasChange` expresses one change per command, so
		// `frame.remove-layout` reports the `autoLayout` key change and not the
		// descendant geometry it also rewrote, and
		// `selection.wrap-in-layout-frame` reports the added frame and not the
		// N reparents. This matches the `node.group` precedent exactly. It is
		// safe because `CanvasChangeRecord` carries the ORIGINAL command and
		// `replayChanges` replays commands rather than diffs — so replay stays
		// lossless even where the derived diff is not. A consumer that needs
		// the full effect must read `record.command`, not `record.change`.
		case "frame.set-layout":
		case "frame.remove-layout":
			return { kind: "updated", nodeId: cmd.nodeId, keys: ["autoLayout"] };
		case "selection.wrap-in-layout-frame":
			return { kind: "added", nodeId: cmd.frameId, pageId: cmd.pageId };
		case "page.create":
			return { kind: "page", pageId: cmd.page.id, op: "create" };
		case "page.delete":
			return { kind: "page", pageId: cmd.pageId, op: "delete" };
		case "page.rename":
			return { kind: "page", pageId: cmd.pageId, op: "rename" };
		case "page.duplicate":
			return { kind: "page", pageId: cmd.newPageId, op: "duplicate" };
		case "page.resize":
			return { kind: "page", pageId: cmd.pageId, op: "resize" };
		case "page.set-background":
			return { kind: "page", pageId: cmd.pageId, op: "background" };
		case "page.set-layout-aids":
			return { kind: "page", pageId: cmd.pageId, op: "layout-aids" };
		case "page.reorder":
			return { kind: "page", pageId: cmd.pageId, op: "reorder" };
		case "component.create":
			return {
				kind: "component",
				componentId:
					cmd.mode === "restore" ? cmd.definition.id : cmd.componentId,
				op: "create",
			};
		case "component.rename":
			return {
				kind: "component",
				componentId: cmd.componentId,
				op: "rename",
				...(cmd.revision !== undefined ? { revision: cmd.revision } : {}),
			};
		case "component.duplicate":
			return {
				kind: "component",
				componentId: cmd.newComponentId,
				op: "duplicate",
			};
		case "component.delete":
			return { kind: "component", componentId: cmd.componentId, op: "delete" };
		case "component.add-property":
			return {
				kind: "component",
				componentId: cmd.componentId,
				op: "add-property",
				...(cmd.revision !== undefined ? { revision: cmd.revision } : {}),
			};
		case "component.update-property":
			return {
				kind: "component",
				componentId: cmd.componentId,
				op: "update-property",
				...(cmd.revision !== undefined ? { revision: cmd.revision } : {}),
			};
		case "component.remove-property":
			return {
				kind: "component",
				componentId: cmd.componentId,
				op: "remove-property",
				...(cmd.revision !== undefined ? { revision: cmd.revision } : {}),
			};
		case "component-instance.insert":
			return {
				kind: "added",
				nodeId: cmd.instanceId,
				pageId:
					cmd.pageId ??
					(cmd.location?.kind === "page" ? cmd.location.id : undefined),
			};
		case "component-instance.set-override":
		case "component-instance.reset-override":
		case "component-instance.reset-all-overrides":
			return { kind: "updated", nodeId: cmd.nodeId, keys: ["overrides"] };
		// Deliberately LOSSY like the other composite commands: the record
		// reports the in-place node swap (the materialized root keeps the
		// instance's id, so `nodeId` stays addressable); the full subtree it
		// spliced in rides on `record.command` for lossless replay.
		case "component-instance.detach":
			return {
				kind: "updated",
				nodeId: cmd.nodeId,
				keys: ["type", "children"],
			};
		case "batch":
			// Batches carry no single record; applyCommands maps each sub-command.
			return null;
		default:
			// Compile-time exhaustiveness (T-M0-02): every `CanvasCommand`
			// member is handled above, so `cmd` narrows to `never` here. Adding
			// a command without a case makes this assignment fail typecheck,
			// naming the unhandled command — previously an omission fell out of
			// the switch and returned `undefined`, silently violating the
			// declared `CanvasChange | null` return type.
			return assertNoUnmappedCommand(cmd);
	}
}

/**
 * Exhaustiveness guard for {@link commandToChange}.
 *
 * Returns `null` rather than throwing: the parameter type makes an unmapped
 * BUILT-IN command a compile error, which is where that defect belongs, while
 * the runtime path stays non-fatal for a caller that reaches here with a cast
 * or extension-authored command. Throwing would turn a missing change record —
 * a telemetry/collab concern — into a failed edit.
 */
function assertNoUnmappedCommand(_cmd: never): null {
	return null;
}

/**
 * The `component`-kind change for a Source-scoped node command, or `null`
 * when the command isn't one. Only node commands carry `location`; page,
 * asset, and batch commands never reach the true branch.
 */
function componentSourceChange(cmd: CanvasCommand): CanvasChange | null {
	// Registry commands (`component.*`) carry their own precise op below —
	// only tree-content commands (node + instance) collapse to `source-edit`.
	if (cmd.type.startsWith("component.")) return null;
	if (!("location" in cmd) || cmd.location?.kind !== "component") return null;
	return {
		kind: "component",
		componentId: cmd.location.id,
		op: "source-edit",
	};
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
	return change.kind === "page" ||
		change.kind === "asset" ||
		change.kind === "component"
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
	if (change.kind === "component") return undefined; // Registry-level, no page
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
