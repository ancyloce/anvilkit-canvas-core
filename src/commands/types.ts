import type {
	CanvasAssetRef,
	CanvasAutoLayout,
	CanvasBounds,
	CanvasComponentDefinition,
	CanvasComponentOverride,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
	CanvasGroupNode,
	CanvasIR,
	CanvasLayoutItem,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
	CanvasPageBackground,
	CanvasPageLayoutAids,
	CanvasTransform,
} from "../ir/types.js";
import type { CanvasDocumentLocation } from "../ir/walkers.js";
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

/**
 * Targets a node command at one tree: a page's (the default when absent —
 * every pre-component call site keeps its exact semantics) or a Component
 * Source's (plan 0023 M3-02, LC-CMD/LC-CREATE-002). A command's inverse
 * carries the same `location`, so undo edits the same tree. One successful
 * command (or one `batch`/transaction) against a Source increments that
 * definition's `revision` exactly once — see `applyCommand`.
 */
export interface CanvasCommandLocationOptions {
	location?: CanvasDocumentLocation;
}

export interface CanvasNodeCreateCommand extends CanvasCommandLocationOptions {
	type: "node.create";
	node: CanvasNode;
	/** Required without `location`; ignored when `location` names the tree. */
	pageId?: string;
	parentId?: string;
	index?: number;
}

export interface CanvasNodeMoveCommand extends CanvasCommandLocationOptions {
	type: "node.move";
	nodeId: string;
	from: CanvasPoint;
	to: CanvasPoint;
}

export interface CanvasNodeResizeCommand extends CanvasCommandLocationOptions {
	type: "node.resize";
	nodeId: string;
	from: CanvasRect;
	to: CanvasRect;
}

export interface CanvasNodeRotateCommand extends CanvasCommandLocationOptions {
	type: "node.rotate";
	nodeId: string;
	from: number;
	to: number;
}

export interface CanvasNodeDeleteCommand extends CanvasCommandLocationOptions {
	type: "node.delete";
	nodeId: string;
}

/**
 * Move a node to a new index among its siblings (same parent). `toIndex` is
 * clamped to the sibling range; the inverse restores the prior index.
 */
export interface CanvasNodeReorderCommand extends CanvasCommandLocationOptions {
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
export interface CanvasNodeReparentCommand
	extends CanvasCommandLocationOptions {
	type: "node.reparent";
	nodeId: string;
	toParentId: string;
	toIndex: number;
}

export interface CanvasNodeUpdateCommand<K extends CanvasNodeKind>
	extends CanvasCommandLocationOptions {
	type: "node.update";
	nodeId: string;
	kind: K;
	patch: Partial<Omit<CanvasNodeByKind<K>, "id" | "type">>;
}

export type CanvasAnyNodeUpdateCommand = {
	[K in CanvasNodeKind]: CanvasNodeUpdateCommand<K>;
}[CanvasNodeKind];

export interface CanvasImageReplaceCommand
	extends CanvasCommandLocationOptions {
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
export interface CanvasNodeGroupCommand extends CanvasCommandLocationOptions {
	type: "node.group";
	/** Required without `location`; ignored when `location` names the tree. */
	pageId?: string;
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
export interface CanvasNodeUngroupCommand extends CanvasCommandLocationOptions {
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
export interface CanvasNodeApplyStyleCommand
	extends CanvasCommandLocationOptions {
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
 * Duplicate a page (§9.1/§23, PRD 0012): deep-clones `sourcePageId`'s node
 * tree with fresh ids via `regenerateNodeIds` (M0-05), preserves the source
 * page's `size`/`background`/`layoutAids`/other page-level fields, and
 * inserts the duplicate immediately after the source. This is real command
 * domain logic (ID regeneration + positioning), not something a consumer
 * should assemble client-side from `clonePage` + `page.create`.
 *
 * `newPageId` follows the same caller-supplies-the-id convention
 * `page.create`'s `page.id` uses — deterministic/testable/replayable, and it
 * lets `commandToChange` (`change-events.ts`) derive a `"page"` change record
 * from the command shape alone, exactly like every other id-producing
 * built-in. `name` overrides the default `"<source name> copy"` label. The
 * inverse is a `page.delete` for `newPageId`, removing exactly the duplicate
 * and leaving the source and all other pages untouched.
 */
export interface CanvasPageDuplicateCommand {
	type: "page.duplicate";
	sourcePageId: string;
	newPageId: string;
	name?: string;
}

/** FR-063 page-resize content handling (B-01, PRD 0012). */
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

// ---------------------------------------------------------------------------
// Local Components — registry + instance commands (plan 0023 M3-02, LC-CMD).
// Registry commands manage their definition's `revision` themselves: a
// content-bearing edit writes `revision ?? prior + 1`, and every inverse
// carries the ACTUAL prior revision (the page.set-background convention), so
// command → inverse → original round-trips byte-identically. Instance
// commands are ordinary node edits on the instance node and never touch the
// Registry.
// ---------------------------------------------------------------------------

/**
 * Add a Component Source to the Registry.
 *
 * `restore` mode carries the complete definition verbatim — deterministic,
 * replayable, and exactly what `component.delete`'s inverse needs (INV-10:
 * it restores the `components` key itself when it was dropped).
 * `from-selection` mode (M3-05) turns page/Source nodes into a new
 * definition plus a first instance; its IDs are allocated by the caller so
 * replay is deterministic.
 */
export type CanvasComponentCreateCommand =
	| {
			type: "component.create";
			mode: "restore";
			definition: CanvasComponentDefinition;
	  }
	| {
			type: "component.create";
			mode: "from-selection";
			/** Tree the selection lives in. Absent = the page tree holding the nodes. */
			location?: CanvasDocumentLocation;
			selectedNodeIds: string[];
			componentId: string;
			sourceRootId: string;
			firstInstanceId: string;
			name?: string;
			/**
			 * How the Source root is formed: `reuse-container` promotes a single
			 * selected group/frame to the root; `wrap-in-frame` wraps the
			 * selection in a new frame at the selection's world AABB. Default:
			 * `reuse-container` for a single container selection, else
			 * `wrap-in-frame`.
			 */
			rootStrategy?: "reuse-container" | "wrap-in-frame";
	  };

export interface CanvasComponentRenameCommand {
	type: "component.rename";
	componentId: string;
	/** Informational prior name (the page.rename convention). */
	from?: string;
	to: string;
	/** Write this exact revision instead of `prior + 1` — how an inverse restores the ACTUAL prior. */
	revision?: number;
}

/**
 * Copy a definition under a new id. Source node ids are remapped via
 * `regenerateNodeIds` (INV-2: unique across Pages AND definitions) and
 * property bindings follow the same id map; Property IDs are kept —
 * cross-definition reuse is explicitly permitted (TD §5.5). The copy starts
 * at `revision: 1` with no dependents.
 */
export interface CanvasComponentDuplicateCommand {
	type: "component.duplicate";
	componentId: string;
	/** Caller-supplied, following the `node.group`/`page.duplicate` id convention. */
	newComponentId: string;
	/** Default: `"<source name> copy"`. */
	name?: string;
}

/**
 * Delete a definition with ZERO references (LC-DELETE). Any remaining page
 * instance or dependent definition rejects the command — "detach all and
 * delete" is a `component-ops` orchestration that builds one atomic batch.
 * Deleting the last definition drops the `components` key entirely; the
 * inverse (`component.create` restore) brings the key back (INV-10).
 */
export interface CanvasComponentDeleteCommand {
	type: "component.delete";
	componentId: string;
}

/**
 * Expose a component property (M3-06, LC-CREATE-003). Rejected on write when
 * the Property ID already exists on this definition, the target node is not
 * in the Source tree, or the target kind is incompatible (§10.1) — the same
 * table `validateComponentGraph` applies on read.
 */
export interface CanvasComponentAddPropertyCommand {
	type: "component.add-property";
	componentId: string;
	property: CanvasComponentProperty;
	/** Insertion index into `properties` (append when omitted) — gives remove's inverse an exact slot. */
	index?: number;
	/** Write this exact revision instead of `prior + 1` (inverse convention). */
	revision?: number;
}

/**
 * Replace one property wholesale (rename, retarget, re-kind). The Property
 * ID is STABLE (INV-6): `to.id` must equal `propertyId` — renaming a
 * property never changes its identity, so instance overrides keep applying.
 */
export interface CanvasComponentUpdatePropertyCommand {
	type: "component.update-property";
	componentId: string;
	propertyId: string;
	to: CanvasComponentProperty;
	revision?: number;
}

/**
 * Remove a property. Existing instance overrides for the id are NOT touched
 * — they become orphans, retained verbatim, and re-apply if the same
 * Property ID is later restored compatibly (§10.3). The Editor owns the
 * "overrides exist — confirm?" prompt; the command itself is unconditional.
 */
export interface CanvasComponentRemovePropertyCommand {
	type: "component.remove-property";
	componentId: string;
	propertyId: string;
	revision?: number;
}

/**
 * Insert a new instance node referencing `componentId` (LC-INSTANCE-001).
 * A dedicated command (not bare `node.create`) so the Source reference is
 * validated at the boundary — a typo never silently creates a broken
 * reference. `pageId` is required without `location`, like `node.create`.
 */
export interface CanvasComponentInstanceInsertCommand
	extends CanvasCommandLocationOptions {
	type: "component-instance.insert";
	componentId: string;
	/** Caller-supplied instance node id (deterministic/replayable). */
	instanceId: string;
	pageId?: string;
	parentId?: string;
	index?: number;
	bounds: CanvasBounds;
	transform?: Partial<CanvasTransform>;
	overrides?: CanvasComponentOverrideMap;
	name?: string;
	layoutItem?: CanvasLayoutItem;
}

/**
 * Set one typed override, keyed by Property ID (LC-INSTANCE-003, INV-6).
 * Writes the entry verbatim — target validation happens at resolve time, so
 * an entry whose property has since changed is retained as an orphan rather
 * than rejected here (§10.3). The inverse restores the prior entry, or
 * resets the key when there was none.
 */
export interface CanvasComponentInstanceSetOverrideCommand
	extends CanvasCommandLocationOptions {
	type: "component-instance.set-override";
	nodeId: string;
	propertyId: string;
	value: CanvasComponentOverride;
}

/** Remove one override. Resetting an absent key is a validated no-op. */
export interface CanvasComponentInstanceResetOverrideCommand
	extends CanvasCommandLocationOptions {
	type: "component-instance.reset-override";
	nodeId: string;
	propertyId: string;
}

/** Remove every override on the instance. The inverse restores the exact prior map. */
export interface CanvasComponentInstanceResetAllOverridesCommand
	extends CanvasCommandLocationOptions {
	type: "component-instance.reset-all-overrides";
	nodeId: string;
}

/**
 * Materialize an instance into plain nodes at the exact same tree position
 * (M3-07, LC-INSTANCE-005). Resolution runs fully first — overrides applied,
 * nested instances expanded recursively (never "outer only") — and fails
 * atomically when it cannot (missing Source, cycle/depth/budget degradation).
 * The materialized root keeps the instance's persistent id, placement, and
 * `layoutItem` (a Flow child keeps its slot); descendants take ids from
 * `nodeIds` (keyed by the resolver's deterministic virtual ids) or a fresh
 * factory. Component metadata, virtual ids, and override maps are gone from
 * the result (INV-12: world-space appearance is preserved exactly). Build
 * the payload with `component-ops` `buildDetachCommand` to get the complete
 * id map back.
 */
export interface CanvasComponentInstanceDetachCommand
	extends CanvasCommandLocationOptions {
	type: "component-instance.detach";
	nodeId: string;
	/** virtual node id → persistent id for the materialized descendants. */
	nodeIds?: Readonly<Record<string, string>>;
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

/**
 * One node's caller-computed geometry, written atomically as part of a layout
 * command.
 *
 * **The caller computes these, not `commands/`.** `commands/` is layering rank
 * 3 and `layout/` (the resolver) is rank 4, so a command handler cannot call
 * the resolver — it would be an upward import. Passing resolved values in the
 * payload is what keeps that boundary intact, and it also makes every layout
 * command deterministic and replayable from its payload alone, with no
 * dependence on which resolver version the replaying build happens to ship.
 */
export interface CanvasLayoutGeometryWrite {
	nodeId: string;
	transform?: CanvasTransform;
	bounds?: CanvasBounds;
	/** Replaces `layoutItem`; `null` clears it (the field is dropped entirely). */
	layoutItem?: CanvasLayoutItem | null;
}

/**
 * Set or replace a frame's Auto Layout intent, optionally writing resolved
 * geometry for its descendants in the same atomic step.
 *
 * Also the vehicle for batched Inspector property edits: changing gap,
 * padding, direction and alignment together is one `frame.set-layout`, hence
 * one Undo entry, rather than four commands.
 */
export interface CanvasFrameSetLayoutCommand
	extends CanvasCommandLocationOptions {
	type: "frame.set-layout";
	nodeId: string;
	layout: CanvasAutoLayout;
	/** Caller-computed geometry to write alongside the intent. */
	geometry?: readonly CanvasLayoutGeometryWrite[];
}

/**
 * Remove a frame's Auto Layout intent, baking the caller-computed resolved
 * geometry into its descendants so the document keeps its appearance.
 *
 * The inverse restores both the intent and every prior geometry value, so a
 * remove/undo round-trip is exact.
 */
export interface CanvasFrameRemoveLayoutCommand
	extends CanvasCommandLocationOptions {
	type: "frame.remove-layout";
	nodeId: string;
	/** Resolved geometry to bake in as the descendants' new authoritative values. */
	geometry?: readonly CanvasLayoutGeometryWrite[];
}

/**
 * Wrap sibling nodes in a NEW Auto Layout frame.
 *
 * Mirrors `node.group` — same-parent validation, current sibling z-order, the
 * topmost selected node's slot, a caller-supplied stable id — with one
 * deliberate difference: `node.group` creates an *identity* group so grouping
 * is visually a no-op, whereas this creates a frame that lays its children
 * out, so child transforms **do** change and the inverse must restore them
 * explicitly (which is what `geometry` is for).
 */
export interface CanvasSelectionWrapInLayoutFrameCommand {
	type: "selection.wrap-in-layout-frame";
	pageId: string;
	childIds: string[];
	/** Caller-supplied stable id, following the `node.group`/`page.duplicate` convention. */
	frameId: string;
	frameName?: string;
	/** Caller-computed frame placement (typically the selection bounds). */
	transform: CanvasTransform;
	bounds: CanvasBounds;
	layout: CanvasAutoLayout;
	/** Caller-computed child geometry, relative to the new frame. */
	geometry?: readonly CanvasLayoutGeometryWrite[];
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
	| CanvasFrameSetLayoutCommand
	| CanvasFrameRemoveLayoutCommand
	| CanvasSelectionWrapInLayoutFrameCommand
	| CanvasPageCreateCommand
	| CanvasPageReorderCommand
	| CanvasPageRenameCommand
	| CanvasPageDuplicateCommand
	| CanvasPageResizeCommand
	| CanvasPageSetBackgroundCommand
	| CanvasPageSetLayoutAidsCommand
	| CanvasPageDeleteCommand
	| CanvasAssetPutCommand
	| CanvasAssetRemoveCommand
	| CanvasComponentCreateCommand
	| CanvasComponentRenameCommand
	| CanvasComponentDuplicateCommand
	| CanvasComponentDeleteCommand
	| CanvasComponentAddPropertyCommand
	| CanvasComponentUpdatePropertyCommand
	| CanvasComponentRemovePropertyCommand
	| CanvasComponentInstanceInsertCommand
	| CanvasComponentInstanceSetOverrideCommand
	| CanvasComponentInstanceResetOverrideCommand
	| CanvasComponentInstanceResetAllOverridesCommand
	| CanvasComponentInstanceDetachCommand
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
