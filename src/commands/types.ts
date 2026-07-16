import type {
	CanvasAssetRef,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
	CanvasPageBackground,
	CanvasPageLayoutAids,
} from "../ir/types.js";
import type { CanvasNodeStyle } from "./apply-style.js";

export interface CanvasPoint {
	x: number;
	y: number;
}

export interface CanvasRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CanvasNodeCreateCommand {
	type: "node.create";
	node: CanvasNode;
	pageId: string;
	parentId?: string;
	index?: number;
}

export interface CanvasNodeMoveCommand {
	type: "node.move";
	nodeId: string;
	from: CanvasPoint;
	to: CanvasPoint;
}

export interface CanvasNodeResizeCommand {
	type: "node.resize";
	nodeId: string;
	from: CanvasRect;
	to: CanvasRect;
}

export interface CanvasNodeRotateCommand {
	type: "node.rotate";
	nodeId: string;
	from: number;
	to: number;
}

export interface CanvasNodeDeleteCommand {
	type: "node.delete";
	nodeId: string;
}

/**
 * Move a node to a new index among its siblings (same parent). `toIndex` is
 * clamped to the sibling range; the inverse restores the prior index.
 */
export interface CanvasNodeReorderCommand {
	type: "node.reorder";
	nodeId: string;
	toIndex: number;
}

/**
 * Move a node into a different container (group/frame/page-root group) at
 * `toIndex` (A-01, PRD 0012 FR-052). Same-page only; `toIndex` is clamped to
 * the target's child range; moving a node into itself or a descendant is
 * rejected (`invariant-violated`); page roots cannot be reparented. The
 * inverse reparents back to the original parent at the original index, so
 * layer-panel drag-and-drop is fully undoable.
 */
export interface CanvasNodeReparentCommand {
	type: "node.reparent";
	nodeId: string;
	toParentId: string;
	toIndex: number;
}

export interface CanvasNodeUpdateCommand<K extends CanvasNodeKind> {
	type: "node.update";
	nodeId: string;
	kind: K;
	patch: Partial<Omit<CanvasNodeByKind<K>, "id" | "type">>;
}

export type CanvasAnyNodeUpdateCommand = {
	[K in CanvasNodeKind]: CanvasNodeUpdateCommand<K>;
}[CanvasNodeKind];

export interface CanvasImageReplaceCommand {
	type: "image.replace";
	nodeId: string;
	fromAssetId: string;
	toAssetId: string;
}

/**
 * Wrap one or more sibling nodes in a new group node. All `childIds` must share
 * the same immediate parent group on `pageId`; they are wrapped in their current
 * sibling z-order and the new group takes the slot of the topmost selected node.
 * No child transforms are altered (the group is created with an identity
 * transform), so grouping is visually a no-op and exactly reversible.
 */
export interface CanvasNodeGroupCommand {
	type: "node.group";
	pageId: string;
	childIds: string[];
	groupId: string;
	groupName?: string;
	/**
	 * When present (e.g. as the inverse of `node.ungroup`), the created group is
	 * reconstructed verbatim from these fields rather than as a canonical identity
	 * group. `children` are always supplied from `childIds`.
	 */
	groupTemplate?: Omit<CanvasGroupNode, "children">;
}

/**
 * Dissolve a group, lifting its children into the group's parent. By default the
 * children spill out contiguously at the group's former slot. When `restore` is
 * present (as produced by the inverse of `node.group`), each child is instead
 * placed back at its recorded original index so the prior tree is reconstructed
 * exactly even for non-contiguous selections.
 */
export interface CanvasNodeUngroupCommand {
	type: "node.ungroup";
	groupId: string;
	restore?: Array<{ id: string; index: number }>;
}

/**
 * Paste style onto one node (C-05, FR-121): the payload is intersected with
 * the target kind's compatible keys via `computeStylePatch` — incompatible
 * keys are ignored (callers report them), never a failure. The inverse is a
 * `node.update` restoring the applied keys' prior values exactly. Multi-node
 * paste is a `batch` of these (one per target — one undo entry).
 */
export interface CanvasNodeApplyStyleCommand {
	type: "node.applyStyle";
	nodeId: string;
	style: CanvasNodeStyle;
}

export interface CanvasPageCreateCommand {
	type: "page.create";
	page: CanvasPage;
	index?: number;
}

export interface CanvasPageReorderCommand {
	type: "page.reorder";
	pageId: string;
	from: number;
	to: number;
}

export interface CanvasPageDeleteCommand {
	type: "page.delete";
	pageId: string;
}

export interface CanvasPageRenameCommand {
	type: "page.rename";
	pageId: string;
	from: string | undefined;
	to: string | undefined;
}

/**
 * FR-063 page-resize content handling (B-01, PRD 0012). NOTE: page
 * DUPLICATION deliberately has no dedicated command — `clonePage` (fresh ids
 * via `regenerateNodeIds`) + `page.create` is deterministic and undoable, and
 * §9.1 forbids commands without their own domain semantics.
 */
export type CanvasPageResizeMode = "canvas-only" | "scale-content" | "recenter";

/**
 * Set a page's background fill (B-11, FR-063/§9.1). The inverse restores the
 * ACTUAL prior background, even when `from` is stale.
 */
export interface CanvasPageSetBackgroundCommand {
	type: "page.set-background";
	pageId: string;
	from?: CanvasPageBackground;
	to: CanvasPageBackground;
}

/**
 * Set (or clear, with `to: undefined`) a page's layout aids — persistent
 * guides, margin, bleed, safe area (C-01, PRD 0012 §9.3/FR-111/FR-113).
 * Whole-object replace: guide add/move/delete are expressed by writing the
 * full next `layoutAids` value, keeping the inverse trivial and exact. The
 * inverse restores the ACTUAL prior value, even when `from` is stale.
 */
export interface CanvasPageSetLayoutAidsCommand {
	type: "page.set-layout-aids";
	pageId: string;
	from?: CanvasPageLayoutAids;
	to: CanvasPageLayoutAids | undefined;
}

/**
 * Resize a page (B-01). `mode` decides what happens to the page's top-level
 * content: `canvas-only` leaves it untouched, `scale-content` scales each
 * top-level child's transform uniformly by min(w-ratio, h-ratio), `recenter`
 * keeps content size and shifts it by half the size delta. The root group's
 * bounds stay synced to the page size. The inverse restores the prior size
 * AND the exact prior child transforms (a composite batch for
 * `scale-content`, where a reciprocal scale would drift in floating point).
 */
export interface CanvasPageResizeCommand {
	type: "page.resize";
	pageId: string;
	from: { width: number; height: number };
	to: { width: number; height: number };
	/** Default `"canvas-only"`. */
	mode?: CanvasPageResizeMode;
}

/**
 * Upsert an entry in the document's asset table, keyed by `asset.id`
 * (A-05/FR-021 paste, later FR-091 upload). Inverse restores the previous
 * entry, or removes the key when it was new — so a paste batch of
 * `asset.put` + `node.create` commands undoes cleanly in one step.
 */
export interface CanvasAssetPutCommand {
	type: "asset.put";
	asset: CanvasAssetRef;
}

/**
 * Remove an asset-table entry. The command layer does NOT check for nodes
 * still referencing the asset (invariants are a trust-boundary tool, not
 * auto-wired — see `ir/invariants.ts`); callers own that check.
 */
export interface CanvasAssetRemoveCommand {
	type: "asset.remove";
	assetId: string;
}

/**
 * A composite, reversible command: applies its `commands` in order as a single
 * undoable unit. Its inverse (produced by `applyCommand`) is another `batch`
 * whose sub-commands are the reversed inverses, so history replays it like any
 * other command with no special-casing. Nestable.
 */
export interface CanvasBatchCommand {
	type: "batch";
	label?: string;
	commands: CanvasCommand[];
}

export type CanvasCommand =
	| CanvasNodeCreateCommand
	| CanvasNodeMoveCommand
	| CanvasNodeResizeCommand
	| CanvasNodeRotateCommand
	| CanvasNodeDeleteCommand
	| CanvasNodeReorderCommand
	| CanvasNodeReparentCommand
	| CanvasAnyNodeUpdateCommand
	| CanvasNodeApplyStyleCommand
	| CanvasImageReplaceCommand
	| CanvasNodeGroupCommand
	| CanvasNodeUngroupCommand
	| CanvasPageCreateCommand
	| CanvasPageReorderCommand
	| CanvasPageRenameCommand
	| CanvasPageResizeCommand
	| CanvasPageSetBackgroundCommand
	| CanvasPageSetLayoutAidsCommand
	| CanvasPageDeleteCommand
	| CanvasAssetPutCommand
	| CanvasAssetRemoveCommand
	| CanvasBatchCommand;

export type CanvasCommandKind = CanvasCommand["type"];

/**
 * `Inverse` defaults to the built-in {@link CanvasCommand} union, so every
 * existing built-in-only call site (`applyCommand`, `applyCommands`, the
 * Editor's history store) needs no type argument and no change. A command
 * extension whose natural inverse is itself a custom command type supplies
 * `Inverse` explicitly (see `CanvasCommandHandler`) instead of casting
 * `inverse` to the built-in union (P0-4).
 */
export interface CommandApplyResult<
	Inverse extends { type: string } = CanvasCommand,
> {
	ir: CanvasIR;
	inverse: Inverse;
}

export interface CommandApplyOptions {
	now?: () => string;
	/**
	 * When true, commands that mutate a `locked` node throw a typed
	 * `node-locked` {@link CanvasCommandError} instead of applying (A-02,
	 * PRD 0012 FR-024). Default OFF for backward compatibility — existing
	 * consumers (brand apply with its own `includeLocked` semantics,
	 * extensions, collab replay) are unaffected unless they opt in. The
	 * editor's action layer enables it for user-initiated operations.
	 * Exemption: a `node.update` whose patch touches `locked` always applies —
	 * that is how a locked node gets unlocked. Inside a `batch` the option
	 * propagates to every sub-command; the batch stays all-or-nothing.
	 */
	enforceLocked?: boolean;
}
