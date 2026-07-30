import { resolveNow } from "../clock.js";
import { buildComponentGraph } from "../components/graph.js";
import { propertyTargetsNode } from "../components/validate.js";
import {
	type AffineMatrix,
	childrenBoundsFromExtents,
	decomposeMatrix,
	invertMatrix,
	multiplyMatrix,
	toAffineMatrix,
	transformedBoundsExtent,
} from "../geometry/affine.js";
import { createComponentInstance, createFrame } from "../ir/builders.js";
import {
	CanvasIRMutationError,
	insertNode,
	moveNode,
	removeNode,
	reorderChildren,
	replaceChildrenInParent,
	updateNode,
} from "../ir/mutations.js";
import { regenerateNodeIds } from "../ir/regenerate-ids.js";
import type {
	CanvasAutoLayout,
	CanvasBounds,
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
	CanvasContainerNode,
	CanvasFrameNode,
	CanvasGroupNode,
	CanvasImageNode,
	CanvasIR,
	CanvasNode,
	CanvasNodeByKind,
	CanvasNodeKind,
	CanvasPage,
	CanvasTransform,
} from "../ir/types.js";
import type { CanvasDocumentLocation } from "../ir/walkers.js";
import {
	findNode,
	findNodeInSubtree,
	isContainerNode,
	MAX_TREE_DEPTH,
	parentOf,
	walkDocument,
} from "../ir/walkers.js";
import {
	MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT,
	MAX_COMPONENT_OVERRIDES_PER_INSTANCE,
	MAX_COMPONENT_PROPERTIES_PER_COMPONENT,
	MAX_COMPOSITE_COMMAND_DESCENDANTS,
} from "../limits.js";
import { computeStylePatch } from "./apply-style.js";
import type {
	CanvasAnyNodeUpdateCommand,
	CanvasAssetPutCommand,
	CanvasAssetRemoveCommand,
	CanvasBatchCommand,
	CanvasCommand,
	CanvasComponentAddPropertyCommand,
	CanvasComponentCreateCommand,
	CanvasComponentDeleteCommand,
	CanvasComponentDuplicateCommand,
	CanvasComponentInstanceInsertCommand,
	CanvasComponentInstanceResetAllOverridesCommand,
	CanvasComponentInstanceResetOverrideCommand,
	CanvasComponentInstanceSetOverrideCommand,
	CanvasComponentRemovePropertyCommand,
	CanvasComponentRenameCommand,
	CanvasComponentUpdatePropertyCommand,
	CanvasFrameRemoveLayoutCommand,
	CanvasFrameSetLayoutCommand,
	CanvasImageReplaceCommand,
	CanvasLayoutGeometryWrite,
	CanvasNodeApplyStyleCommand,
	CanvasNodeCreateCommand,
	CanvasNodeDeleteCommand,
	CanvasNodeGroupCommand,
	CanvasNodeMoveCommand,
	CanvasNodeReorderCommand,
	CanvasNodeReparentCommand,
	CanvasNodeResizeCommand,
	CanvasNodeRotateCommand,
	CanvasNodeUngroupCommand,
	CanvasPageCreateCommand,
	CanvasPageDeleteCommand,
	CanvasPageDuplicateCommand,
	CanvasPageRenameCommand,
	CanvasPageReorderCommand,
	CanvasPageResizeCommand,
	CanvasPageSetBackgroundCommand,
	CanvasPageSetLayoutAidsCommand,
	CanvasSelectionWrapInLayoutFrameCommand,
	CommandApplyOptions,
	CommandApplyResult,
} from "./types.js";

export type CanvasCommandErrorCode =
	| "node-not-found"
	| "parent-not-found"
	| "parent-not-group"
	| "page-not-found"
	| "location-not-found"
	| "kind-mismatch"
	| "asset-mismatch"
	| "asset-not-found"
	| "index-out-of-range"
	| "invariant-violated"
	| "node-locked"
	| "unknown-command";

export class CanvasCommandError extends Error {
	readonly code: CanvasCommandErrorCode;

	constructor(code: CanvasCommandErrorCode, message: string) {
		super(message);
		this.name = "CanvasCommandError";
		this.code = code;
	}
}

/**
 * Stamp `updatedAt` and drop the materialized-layout cache stamp.
 *
 * Every command routes through here, and every command changes the inputs a
 * layout resolution depended on — so a stamp surviving one would claim a
 * freshness it does not have, and `layout-materialization-stale` would then
 * never fire for it. A stamp that lies is strictly worse than no stamp
 * (PRD 0014 §9.4), so it is cleared here rather than at the handful of sites
 * the plan enumerates: `page.duplicate` and the `page.create` batch
 * `resizeToVariants` produces are then covered by construction, along with
 * every command added later.
 *
 * This is a **field deletion**, not a resolver call — `commands/` (rank 3)
 * must gain no dependency on `layout/` (rank 4), and does not.
 */
function bumpMetadata(ir: CanvasIR, options: CommandApplyOptions): CanvasIR {
	const { layoutMaterialization: _invalidated, ...rest } = ir;
	return {
		...rest,
		metadata: { ...ir.metadata, updatedAt: resolveNow(options.now)() },
	};
}

function expectPage(ir: CanvasIR, pageId: string): CanvasPage {
	const page = ir.pages.find((p) => p.id === pageId);
	if (!page) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${pageId}" not found`,
		);
	}
	return page;
}

function expectNode(
	ir: CanvasIR,
	id: string,
	location?: CanvasDocumentLocation,
): { node: CanvasNode; page?: CanvasPage } {
	if (!location) {
		const found = findNode(ir, id);
		if (!found) {
			throw new CanvasCommandError(
				"node-not-found",
				`Node id "${id}" not found`,
			);
		}
		return found;
	}
	const found = findNodeInSubtree(resolveScopeRoot(ir, location), id);
	if (!found) {
		throw new CanvasCommandError(
			"node-not-found",
			`Node id "${id}" not found in ${location.kind} "${location.id}"`,
		);
	}
	return {
		node: found.node,
		...(location.kind === "page"
			? { page: ir.pages.find((p) => p.id === location.id) }
			: {}),
	};
}

function rethrowMutationError(err: unknown): never {
	if (err instanceof CanvasIRMutationError) {
		switch (err.code) {
			case "node-not-found":
				throw new CanvasCommandError("node-not-found", err.message);
			case "parent-not-found":
				throw new CanvasCommandError("parent-not-found", err.message);
			// Removing/moving a page root (or a Source root) is an invariant
			// violation, not a missing parent — surface it distinctly.
			case "cannot-remove-page-root":
			case "cannot-move-page-root":
			case "cannot-remove-source-root":
			case "cannot-move-source-root":
			case "invalid-root-replacement":
				throw new CanvasCommandError("invariant-violated", err.message);
			case "parent-not-group":
				throw new CanvasCommandError("parent-not-group", err.message);
			case "index-out-of-range":
				throw new CanvasCommandError("index-out-of-range", err.message);
			case "location-not-found":
				throw new CanvasCommandError("location-not-found", err.message);
			case "cycle-detected":
				throw new CanvasCommandError("invariant-violated", err.message);
		}
	}
	throw err;
}

/**
 * The tree a `location`-carrying command targets. Throws a typed
 * `location-not-found` for a missing page/definition — a command that names
 * a tree that does not exist is a caller defect, never a silent no-op.
 */
function resolveScopeRoot(
	ir: CanvasIR,
	location: CanvasDocumentLocation,
): CanvasNode {
	const root =
		location.kind === "page"
			? ir.pages.find((p) => p.id === location.id)?.root
			: ir.components?.[location.id]?.root;
	if (!root) {
		throw new CanvasCommandError(
			"location-not-found",
			`${location.kind === "page" ? "Page" : "Component definition"} "${location.id}" not found`,
		);
	}
	return root;
}

/**
 * Scoped complement of `findNode`: absent `location` searches every page
 * (the legacy behavior); a `location` searches exactly that tree — so a
 * Source-scoped command can never accidentally hit a same-id page node and
 * vice versa.
 */
function findNodeInScope(
	ir: CanvasIR,
	id: string,
	location: CanvasDocumentLocation | undefined,
): { node: CanvasNode; parent: CanvasContainerNode | null } | null {
	if (!location) {
		const found = findNode(ir, id);
		if (!found) return null;
		const parentResult = parentOf(ir, id);
		return { node: found.node, parent: parentResult?.parent ?? null };
	}
	return findNodeInSubtree(resolveScopeRoot(ir, location), id);
}

/**
 * A-02 lock guard: with `options.enforceLocked`, mutating a locked node is a
 * typed `node-locked` error. Unknown ids are ignored here — the calling apply
 * function raises its own precise not-found error.
 */
function assertUnlocked(
	ir: CanvasIR,
	nodeId: string,
	options: CommandApplyOptions,
	location?: CanvasDocumentLocation,
): void {
	if (options.enforceLocked !== true) return;
	const found = findNodeInScope(ir, nodeId, location);
	if (found && found.node.locked === true) {
		throw new CanvasCommandError(
			"node-locked",
			`Node "${nodeId}" is locked (enforceLocked)`,
		);
	}
}

function resolveParentId(
	ir: CanvasIR,
	cmd: {
		pageId?: string;
		parentId?: string;
		location?: CanvasDocumentLocation;
	},
): string {
	if (cmd.location) {
		return cmd.parentId ?? resolveScopeRoot(ir, cmd.location).id;
	}
	if (cmd.pageId === undefined) {
		throw new CanvasCommandError(
			"page-not-found",
			"A node command without a location must carry pageId",
		);
	}
	const page = expectPage(ir, cmd.pageId);
	return cmd.parentId ?? page.root.id;
}

/**
 * Spread-friendly `location` forwarding: mutation options and inverse
 * commands carry the SAME location the command did, and none at all when the
 * command had none (an absent key, not `location: undefined`).
 */
function locationSpread(cmd: { location?: CanvasDocumentLocation }): {
	location?: CanvasDocumentLocation;
} {
	return cmd.location !== undefined ? { location: cmd.location } : {};
}

/** `pageId` for page-tree commands; typed error when neither it nor `location` is given. */
function requirePageId(cmd: { type: string; pageId?: string }): string {
	if (cmd.pageId === undefined) {
		throw new CanvasCommandError(
			"page-not-found",
			`${cmd.type} without a location must carry pageId`,
		);
	}
	return cmd.pageId;
}

function locateSiblingIndex(
	parent: CanvasContainerNode,
	childId: string,
): number {
	const idx = parent.children.findIndex((c) => c.id === childId);
	if (idx < 0) {
		throw new CanvasCommandError(
			"node-not-found",
			`Node "${childId}" not found under parent "${parent.id}"`,
		);
	}
	return idx;
}

function applyNodeCreate(
	ir: CanvasIR,
	cmd: CanvasNodeCreateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const parentId = resolveParentId(ir, cmd);
	let next: CanvasIR;
	try {
		next = insertNode(ir, {
			parentId,
			node: cmd.node,
			...(cmd.index !== undefined ? { index: cmd.index } : {}),
			...(cmd.location !== undefined ? { location: cmd.location } : {}),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeDeleteCommand = {
		type: "node.delete",
		nodeId: cmd.node.id,
		...(cmd.location !== undefined ? { location: cmd.location } : {}),
	};
	return { ir: next, inverse };
}

function applyNodeDelete(
	ir: CanvasIR,
	cmd: CanvasNodeDeleteCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	let node: CanvasNode;
	let parent: CanvasContainerNode;
	// The inverse re-creates the node in the same tree: `pageId` when it lives
	// on a page (resolved for the legacy path exactly as before), `location`
	// when the command was scoped.
	let pageId: string | undefined;
	if (cmd.location) {
		const found = findNodeInSubtree(
			resolveScopeRoot(ir, cmd.location),
			cmd.nodeId,
		);
		if (!found) {
			throw new CanvasCommandError(
				"node-not-found",
				`Node id "${cmd.nodeId}" not found in ${cmd.location.kind} "${cmd.location.id}"`,
			);
		}
		if (!found.parent) {
			throw new CanvasCommandError(
				"parent-not-found",
				`Node "${cmd.nodeId}" has no parent (a tree root)`,
			);
		}
		node = found.node;
		parent = found.parent;
		pageId = cmd.location.kind === "page" ? cmd.location.id : undefined;
	} else {
		const found = expectNode(ir, cmd.nodeId);
		const parentResult = parentOf(ir, cmd.nodeId);
		if (!parentResult) {
			throw new CanvasCommandError(
				"parent-not-found",
				`Node "${cmd.nodeId}" has no parent (likely a page root)`,
			);
		}
		node = found.node;
		parent = parentResult.parent;
		pageId = found.page?.id;
	}
	const index = locateSiblingIndex(parent, cmd.nodeId);
	let next: CanvasIR;
	try {
		next = removeNode(ir, {
			id: cmd.nodeId,
			...(cmd.location !== undefined ? { location: cmd.location } : {}),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeCreateCommand = {
		type: "node.create",
		node,
		...(pageId !== undefined ? { pageId } : {}),
		parentId: parent.id,
		index,
		...(cmd.location !== undefined ? { location: cmd.location } : {}),
	};
	return { ir: next, inverse };
}

function applyNodeMove(
	ir: CanvasIR,
	cmd: CanvasNodeMoveCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const { node } = expectNode(ir, cmd.nodeId, cmd.location);
	const currentX = node.transform.x;
	const currentY = node.transform.y;
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: {
				transform: { ...node.transform, x: cmd.to.x, y: cmd.to.y },
			} as Partial<Omit<CanvasNode, "id" | "type">>,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeMoveCommand = {
		type: "node.move",
		nodeId: cmd.nodeId,
		from: { x: cmd.to.x, y: cmd.to.y },
		to: { x: currentX, y: currentY },
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function applyNodeResize(
	ir: CanvasIR,
	cmd: CanvasNodeResizeCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const { node } = expectNode(ir, cmd.nodeId, cmd.location);
	const currentX = node.transform.x;
	const currentY = node.transform.y;
	const currentW = node.bounds.width;
	const currentH = node.bounds.height;
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: {
				transform: { ...node.transform, x: cmd.to.x, y: cmd.to.y },
				bounds: { width: cmd.to.width, height: cmd.to.height },
			} as Partial<Omit<CanvasNode, "id" | "type">>,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeResizeCommand = {
		type: "node.resize",
		nodeId: cmd.nodeId,
		from: {
			x: cmd.to.x,
			y: cmd.to.y,
			width: cmd.to.width,
			height: cmd.to.height,
		},
		to: {
			x: currentX,
			y: currentY,
			width: currentW,
			height: currentH,
		},
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function applyNodeRotate(
	ir: CanvasIR,
	cmd: CanvasNodeRotateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const { node } = expectNode(ir, cmd.nodeId, cmd.location);
	const currentRotation = node.transform.rotation;
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: {
				transform: { ...node.transform, rotation: cmd.to },
			} as Partial<Omit<CanvasNode, "id" | "type">>,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeRotateCommand = {
		type: "node.rotate",
		nodeId: cmd.nodeId,
		from: cmd.to,
		to: currentRotation,
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function applyNodeUpdate(
	ir: CanvasIR,
	cmd: CanvasAnyNodeUpdateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	// Exempt only a patch that UNLOCKS the node (`locked: false`) — this is how
	// a locked node becomes editable again, and it may legitimately carry other
	// field changes alongside the unlock in the same commit. A patch that
	// merely touches `locked` without setting it to `false` (C-7's `{ locked:
	// true, fill: "red" }` on an already-locked node) must not smuggle other
	// field edits through under this exemption.
	const isUnlockPatch = cmd.patch.locked === false;
	if (!isUnlockPatch) {
		assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	}
	const { node } = expectNode(ir, cmd.nodeId, cmd.location);
	if (node.type !== cmd.kind) {
		throw new CanvasCommandError(
			"kind-mismatch",
			`Node "${cmd.nodeId}" is of kind "${node.type}", not "${cmd.kind}"`,
		);
	}
	// Capture inverse patch: for each key in cmd.patch, record the prior value.
	const patch = cmd.patch as Record<string, unknown>;
	const inversePatch: Record<string, unknown> = {};
	const nodeRecord = node as unknown as Record<string, unknown>;
	for (const key of Object.keys(patch)) {
		inversePatch[key] = nodeRecord[key];
	}
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: cmd.patch as Partial<Omit<CanvasNode, "id" | "type">>,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse = {
		type: "node.update",
		nodeId: cmd.nodeId,
		kind: cmd.kind,
		patch: inversePatch as Partial<
			Omit<CanvasNodeByKind<CanvasNodeKind>, "id" | "type">
		>,
		...locationSpread(cmd),
	} as CanvasAnyNodeUpdateCommand;
	return { ir: next, inverse };
}

function applyNodeApplyStyle(
	ir: CanvasIR,
	cmd: CanvasNodeApplyStyleCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const { node } = expectNode(ir, cmd.nodeId, cmd.location);
	const { patch } = computeStylePatch(node, cmd.style);
	const inversePatch: Record<string, unknown> = {};
	const nodeRecord = node as unknown as Record<string, unknown>;
	for (const key of Object.keys(patch)) {
		inversePatch[key] = nodeRecord[key];
	}
	const inverse = {
		type: "node.update",
		nodeId: cmd.nodeId,
		kind: node.type,
		patch: inversePatch,
		...locationSpread(cmd),
	} as CanvasAnyNodeUpdateCommand;
	if (Object.keys(patch).length === 0) {
		// Every key was incompatible — a reported no-op, never an error (FR-121).
		return { ir, inverse };
	}
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(ir, {
			id: cmd.nodeId,
			patch: patch as Partial<Omit<CanvasNode, "id" | "type">>,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	return { ir: next, inverse };
}

function applyImageReplace(
	ir: CanvasIR,
	cmd: CanvasImageReplaceCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const { node } = expectNode(ir, cmd.nodeId, cmd.location);
	if (node.type !== "image") {
		throw new CanvasCommandError(
			"kind-mismatch",
			`Node "${cmd.nodeId}" is of kind "${node.type}", not "image"`,
		);
	}
	const imageNode = node as CanvasImageNode;
	if (imageNode.assetId !== cmd.fromAssetId) {
		throw new CanvasCommandError(
			"asset-mismatch",
			`Image node "${cmd.nodeId}" assetId "${imageNode.assetId}" does not match expected "${cmd.fromAssetId}"`,
		);
	}
	let next: CanvasIR;
	try {
		next = updateNode<"image">(ir, {
			id: cmd.nodeId,
			patch: { assetId: cmd.toAssetId },
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasImageReplaceCommand = {
		type: "image.replace",
		nodeId: cmd.nodeId,
		fromAssetId: cmd.toAssetId,
		toAssetId: cmd.fromAssetId,
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function computeChildrenBounds(children: readonly CanvasNode[]): CanvasBounds {
	// Transform-aware AABB across all children, anchored to include the group
	// origin (0,0). The merge itself lives in geometry so the resolved-layout
	// path (feeding `layoutFootprint` extents) shares it verbatim.
	return childrenBoundsFromExtents(
		children.map((child) =>
			transformedBoundsExtent(
				child.transform,
				child.bounds.width,
				child.bounds.height,
			),
		),
	);
}

/**
 * Recompute a transform on the far side of `matrix`, keeping the transform's
 * effective WORLD position unchanged when the coordinate space it's declared
 * relative to changes — e.g. `toAffineMatrix(group.transform)` when a child
 * spills out of its group (`node.ungroup`), or
 * `invertMatrix(toAffineMatrix(groupTemplate.transform))` when a child is
 * re-nested under a restored group (`node.group`'s inverse). Omits `skewX`
 * when it decomposes to exactly 0, matching how a freshly-authored transform
 * omits it (C-4).
 */
function reprojectTransform(
	matrix: AffineMatrix,
	transform: CanvasTransform,
): CanvasTransform {
	const decomposed = decomposeMatrix(
		multiplyMatrix(matrix, toAffineMatrix(transform)),
	);
	return {
		x: decomposed.x,
		y: decomposed.y,
		rotation: decomposed.rotation,
		scaleX: decomposed.scaleX,
		scaleY: decomposed.scaleY,
		...(decomposed.skewX !== 0 ? { skewX: decomposed.skewX } : {}),
	};
}

interface GroupChildEntry {
	id: string;
	node: CanvasNode;
	index: number;
}

function applyNodeGroup(
	ir: CanvasIR,
	cmd: CanvasNodeGroupCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	for (const childId of cmd.childIds) {
		assertUnlocked(ir, childId, options, cmd.location);
	}
	if (cmd.childIds.length === 0) {
		throw new CanvasCommandError(
			"invariant-violated",
			"node.group requires at least one childId",
		);
	}
	const uniqueIds = new Set(cmd.childIds);
	if (uniqueIds.size !== cmd.childIds.length) {
		throw new CanvasCommandError(
			"invariant-violated",
			"node.group childIds contains duplicates",
		);
	}
	const page = cmd.location ? undefined : expectPage(ir, requirePageId(cmd));
	if (findNodeInScope(ir, cmd.groupId, cmd.location)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Group id "${cmd.groupId}" already exists`,
		);
	}
	// The common parent of the nodes being grouped may itself be a frame — a group
	// is created *inside* it, which is exactly the group/frame interplay we want.
	let parent: CanvasContainerNode | undefined;
	const entries: GroupChildEntry[] = [];
	for (const id of cmd.childIds) {
		let node: CanvasNode;
		let childParent: CanvasContainerNode | null;
		if (cmd.location) {
			const found = findNodeInSubtree(resolveScopeRoot(ir, cmd.location), id);
			if (!found) {
				throw new CanvasCommandError(
					"node-not-found",
					`Node "${id}" not found in ${cmd.location.kind} "${cmd.location.id}"`,
				);
			}
			node = found.node;
			childParent = found.parent;
		} else {
			const found = findNode(ir, id);
			if (!found || (page && found.page.id !== page.id)) {
				throw new CanvasCommandError(
					"node-not-found",
					`Node "${id}" not found on page "${cmd.pageId}"`,
				);
			}
			node = found.node;
			childParent = parentOf(ir, id)?.parent ?? null;
		}
		if (!childParent) {
			throw new CanvasCommandError(
				"invariant-violated",
				cmd.location?.kind === "component"
					? `Cannot group Component Source root "${id}"`
					: `Cannot group page-root node "${id}"`,
			);
		}
		if (parent === undefined) {
			parent = childParent;
		} else if (parent.id !== childParent.id) {
			throw new CanvasCommandError(
				"invariant-violated",
				"node.group requires all childIds to share the same parent",
			);
		}
		const index = childParent.children.findIndex((c) => c.id === id);
		entries.push({ id, node, index });
	}
	if (parent === undefined) {
		throw new CanvasCommandError(
			"invariant-violated",
			"node.group could not resolve a parent",
		);
	}
	entries.sort((a, b) => a.index - b.index);
	const firstEntry = entries[0];
	if (!firstEntry) {
		throw new CanvasCommandError(
			"invariant-violated",
			"node.group resolved no children",
		);
	}
	const minIndex = firstEntry.index;
	const groupTemplate = cmd.groupTemplate;
	// A templated group (the inverse of `node.ungroup`, C-4) restores a
	// non-identity `transform` — its children must be re-expressed relative to
	// THAT transform (not reused as-is) so their WORLD position doesn't shift
	// by the group's own transform a second time.
	const childNodes = groupTemplate
		? entries.map((e) => ({
				...e.node,
				transform: reprojectTransform(
					invertMatrix(toAffineMatrix(groupTemplate.transform)),
					e.node.transform,
				),
			}))
		: entries.map((e) => e.node);
	const groupNode: CanvasGroupNode = cmd.groupTemplate
		? {
				...cmd.groupTemplate,
				id: cmd.groupId,
				type: "group",
				children: childNodes,
			}
		: {
				id: cmd.groupId,
				type: "group",
				...(cmd.groupName !== undefined ? { name: cmd.groupName } : {}),
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: computeChildrenBounds(childNodes),
				zIndex: 0,
				children: childNodes,
			};
	const parentId = parent.id;
	const selectedIds = new Set(cmd.childIds);
	let next: CanvasIR;
	try {
		// Single tree rewrite: drop the selected siblings and splice the new group
		// in at the topmost selected slot — one O(n) pass, not one per child.
		next = replaceChildrenInParent(ir, {
			parentId,
			replace: (children) => {
				const remaining = children.filter((c) => !selectedIds.has(c.id));
				remaining.splice(minIndex, 0, groupNode);
				return remaining;
			},
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeUngroupCommand = {
		type: "node.ungroup",
		groupId: cmd.groupId,
		restore: entries.map((e) => ({ id: e.id, index: e.index })),
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

/**
 * Apply the caller-computed geometry writes carried by a layout command, and
 * return the writes that would undo them.
 *
 * `mergeNodePatch` deletes any key whose patch value is `undefined`, so a
 * `layoutItem: null` write physically removes the field rather than leaving an
 * `undefined` behind — which is what makes the inverse *exact* rather than
 * merely equivalent-after-serialization.
 *
 * Lock enforcement covers every node named here, because a geometry write
 * moves and resizes that node. It does NOT cover siblings whose index merely
 * shifts as a side effect — locking protects a node's own properties and
 * position, not its neighbours' indices, and the alternative would let one
 * locked child freeze an entire container.
 */
/**
 * Nodes in a subtree, including the root. Used to bound composite layout
 * command payloads (T-M1-09) before any allocation proportional to them.
 */
function countSubtree(node: CanvasNode): number {
	let count = 1;
	if (isContainerNode(node)) {
		for (const child of node.children) count += countSubtree(child);
	}
	return count;
}

/**
 * Reject a composite layout command whose payload exceeds the descendant
 * ceiling, BEFORE doing any O(descendants) work.
 */
function assertWithinCompositeCeiling(
	commandType: string,
	count: number,
	what: string,
): void {
	if (count > MAX_COMPOSITE_COMMAND_DESCENDANTS) {
		throw new CanvasCommandError(
			"invariant-violated",
			`${commandType} exceeds the composite payload ceiling: ${count} ${what} > MAX_COMPOSITE_COMMAND_DESCENDANTS (${MAX_COMPOSITE_COMMAND_DESCENDANTS}). Value + inverse means roughly 2x this per history entry.`,
		);
	}
}

function applyLayoutGeometryWrites(
	ir: CanvasIR,
	writes: readonly CanvasLayoutGeometryWrite[] | undefined,
	options: CommandApplyOptions,
	location?: CanvasDocumentLocation,
): { ir: CanvasIR; prior: CanvasLayoutGeometryWrite[] } {
	const prior: CanvasLayoutGeometryWrite[] = [];
	let next = ir;
	assertWithinCompositeCeiling(
		"A layout command",
		writes?.length ?? 0,
		"geometry writes",
	);
	for (const write of writes ?? []) {
		assertUnlocked(next, write.nodeId, options, location);
		const { node } = expectNode(next, write.nodeId, location);
		const patch: Record<string, unknown> = {};
		const before: CanvasLayoutGeometryWrite = { nodeId: write.nodeId };
		if (write.transform !== undefined) {
			patch.transform = write.transform;
			before.transform = node.transform;
		}
		if (write.bounds !== undefined) {
			patch.bounds = write.bounds;
			before.bounds = node.bounds;
		}
		if (write.layoutItem !== undefined) {
			patch.layoutItem =
				write.layoutItem === null ? undefined : write.layoutItem;
			before.layoutItem = node.layoutItem ?? null;
		}
		if (Object.keys(patch).length === 0) continue;
		try {
			next = updateNode<CanvasNodeKind>(next, {
				id: write.nodeId,
				patch: patch as Partial<Omit<CanvasNode, "id" | "type">>,
				...(location !== undefined ? { location } : {}),
				now: options.now,
			});
		} catch (err) {
			rethrowMutationError(err);
		}
		prior.push(before);
	}
	return { ir: next, prior };
}

function expectFrame(
	ir: CanvasIR,
	nodeId: string,
	location?: CanvasDocumentLocation,
): CanvasFrameNode {
	const { node } = expectNode(ir, nodeId, location);
	if (node.type !== "frame") {
		throw new CanvasCommandError(
			"kind-mismatch",
			`Node "${nodeId}" is of kind "${node.type}", not "frame" — only a frame can carry Auto Layout`,
		);
	}
	return node;
}

/**
 * Build the inverse of a command that changed a frame's layout intent:
 * restore the prior intent if there was one, otherwise remove it again.
 */
function invertFrameLayoutChange(
	nodeId: string,
	previous: CanvasAutoLayout | undefined,
	prior: readonly CanvasLayoutGeometryWrite[],
	location?: CanvasDocumentLocation,
): CanvasFrameSetLayoutCommand | CanvasFrameRemoveLayoutCommand {
	const geometry = prior.length > 0 ? { geometry: prior } : {};
	const scope = location !== undefined ? { location } : {};
	return previous
		? {
				type: "frame.set-layout",
				nodeId,
				layout: previous,
				...geometry,
				...scope,
			}
		: { type: "frame.remove-layout", nodeId, ...geometry, ...scope };
}

function applyFrameSetLayout(
	ir: CanvasIR,
	cmd: CanvasFrameSetLayoutCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const previous = expectFrame(ir, cmd.nodeId, cmd.location).autoLayout;
	const { ir: withGeometry, prior } = applyLayoutGeometryWrites(
		ir,
		cmd.geometry,
		options,
		cmd.location,
	);
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(withGeometry, {
			id: cmd.nodeId,
			patch: { autoLayout: cmd.layout } as Partial<
				Omit<CanvasNode, "id" | "type">
			>,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	return {
		ir: next,
		inverse: invertFrameLayoutChange(cmd.nodeId, previous, prior, cmd.location),
	};
}

function applyFrameRemoveLayout(
	ir: CanvasIR,
	cmd: CanvasFrameRemoveLayoutCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const frame = expectFrame(ir, cmd.nodeId, cmd.location);
	const previous = frame.autoLayout;
	// The inverse must be able to restore every descendant's prior geometry, so
	// the subtree — not just the supplied payload — is what has to stay bounded.
	assertWithinCompositeCeiling(
		"frame.remove-layout",
		countSubtree(frame) - 1,
		"descendants",
	);
	const { ir: withGeometry, prior } = applyLayoutGeometryWrites(
		ir,
		cmd.geometry,
		options,
		cmd.location,
	);
	let next: CanvasIR;
	try {
		next = updateNode<CanvasNodeKind>(withGeometry, {
			// `undefined` deletes the key outright (see mergeNodePatch), so the
			// frame is left with no `autoLayout` rather than an explicit undefined.
			patch: { autoLayout: undefined } as Partial<
				Omit<CanvasNode, "id" | "type">
			>,
			id: cmd.nodeId,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	return {
		ir: next,
		inverse: invertFrameLayoutChange(cmd.nodeId, previous, prior, cmd.location),
	};
}

function applyWrapInLayoutFrame(
	ir: CanvasIR,
	cmd: CanvasSelectionWrapInLayoutFrameCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	for (const childId of cmd.childIds) {
		assertUnlocked(ir, childId, options);
	}
	if (cmd.childIds.length === 0) {
		throw new CanvasCommandError(
			"invariant-violated",
			"selection.wrap-in-layout-frame requires at least one childId",
		);
	}
	if (new Set(cmd.childIds).size !== cmd.childIds.length) {
		throw new CanvasCommandError(
			"invariant-violated",
			"selection.wrap-in-layout-frame childIds contains duplicates",
		);
	}
	const page = expectPage(ir, cmd.pageId);
	if (findNode(ir, cmd.frameId)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Frame id "${cmd.frameId}" already exists`,
		);
	}

	let parent: CanvasContainerNode | undefined;
	const entries: GroupChildEntry[] = [];
	for (const id of cmd.childIds) {
		const found = findNode(ir, id);
		if (!found || found.page.id !== page.id) {
			throw new CanvasCommandError(
				"node-not-found",
				`Node "${id}" not found on page "${cmd.pageId}"`,
			);
		}
		const parentResult = parentOf(ir, id);
		if (!parentResult) {
			throw new CanvasCommandError(
				"invariant-violated",
				`Cannot wrap page-root node "${id}"`,
			);
		}
		if (parent === undefined) {
			parent = parentResult.parent;
		} else if (parent.id !== parentResult.parent.id) {
			throw new CanvasCommandError(
				"invariant-violated",
				"selection.wrap-in-layout-frame requires all childIds to share the same parent",
			);
		}
		entries.push({
			id,
			node: found.node,
			index: parentResult.parent.children.findIndex((c) => c.id === id),
		});
	}
	if (parent === undefined) {
		throw new CanvasCommandError(
			"invariant-violated",
			"selection.wrap-in-layout-frame could not resolve a parent",
		);
	}
	entries.sort((a, b) => a.index - b.index);
	const firstEntry = entries[0];
	if (!firstEntry) {
		throw new CanvasCommandError(
			"invariant-violated",
			"selection.wrap-in-layout-frame resolved no children",
		);
	}
	assertWithinCompositeCeiling(
		"selection.wrap-in-layout-frame",
		entries.reduce((sum, e) => sum + countSubtree(e.node), 0),
		"wrapped nodes",
	);

	const frameNode: CanvasFrameNode = {
		id: cmd.frameId,
		type: "frame",
		...(cmd.frameName !== undefined ? { name: cmd.frameName } : {}),
		transform: cmd.transform,
		bounds: cmd.bounds,
		zIndex: 0,
		autoLayout: cmd.layout,
		children: entries.map((e) => e.node),
	};

	const parentId = parent.id;
	const minIndex = firstEntry.index;
	const selectedIds = new Set(cmd.childIds);
	let next: CanvasIR;
	try {
		next = replaceChildrenInParent(ir, {
			parentId,
			replace: (children) => {
				const remaining = children.filter((c) => !selectedIds.has(c.id));
				remaining.splice(minIndex, 0, frameNode);
				return remaining;
			},
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const { ir: withGeometry, prior } = applyLayoutGeometryWrites(
		next,
		cmd.geometry,
		options,
	);

	// The inverse is expressed entirely in EXISTING commands — no fourth
	// command type is introduced. Reparent restores membership, `node.reorder`
	// then restores the exact permutation (reparent alone cannot: a
	// non-contiguous selection's indices do not survive a straight re-insert
	// while the frame still occupies a slot), `node.delete` drops the emptied
	// frame, and `node.update` restores any geometry this command rewrote.
	const inverse: CanvasBatchCommand = {
		type: "batch",
		label: `unwrap:${cmd.frameId}`,
		commands: [
			...entries.map(
				(e): CanvasNodeReparentCommand => ({
					type: "node.reparent",
					nodeId: e.id,
					toParentId: parentId,
					toIndex: e.index,
				}),
			),
			{ type: "node.delete", nodeId: cmd.frameId },
			...entries.map(
				(e): CanvasNodeReorderCommand => ({
					type: "node.reorder",
					nodeId: e.id,
					toIndex: e.index,
				}),
			),
			...prior.map((write): CanvasCommand => {
				const patch: Record<string, unknown> = {};
				if (write.transform !== undefined) patch.transform = write.transform;
				if (write.bounds !== undefined) patch.bounds = write.bounds;
				if (write.layoutItem !== undefined) {
					patch.layoutItem =
						write.layoutItem === null ? undefined : write.layoutItem;
				}
				return {
					type: "node.update",
					nodeId: write.nodeId,
					kind: (findNode(withGeometry, write.nodeId)?.node.type ??
						"rect") as CanvasNodeKind,
					patch,
				} as CanvasCommand;
			}),
		],
	};
	return { ir: withGeometry, inverse };
}

function applyNodeUngroup(
	ir: CanvasIR,
	cmd: CanvasNodeUngroupCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.groupId, options, cmd.location);
	const found = expectNode(ir, cmd.groupId, cmd.location);
	if (found.node.type !== "group") {
		throw new CanvasCommandError(
			"kind-mismatch",
			`Node "${cmd.groupId}" is of kind "${found.node.type}", not "group"`,
		);
	}
	const group = found.node;
	const scopedParent = cmd.location
		? (findNodeInSubtree(resolveScopeRoot(ir, cmd.location), cmd.groupId)
				?.parent ?? null)
		: (parentOf(ir, cmd.groupId)?.parent ?? null);
	if (!scopedParent || !isContainerNode(scopedParent)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Cannot ungroup parentless group "${cmd.groupId}" (likely a page root)`,
		);
	}
	const parent = scopedParent;
	const groupIndex = parent.children.findIndex((c) => c.id === cmd.groupId);
	const children = group.children;
	const childIds = children.map((c) => c.id);
	const { children: _children, ...groupTemplate } = group;
	const parentId = parent.id;
	const restore = cmd.restore;
	// Pre-validate restore ids so the failure path is independent of the rewrite.
	if (restore && restore.length > 0) {
		for (const { id } of restore) {
			if (!children.some((c) => c.id === id)) {
				throw new CanvasCommandError(
					"invariant-violated",
					`Restore id "${id}" is not a child of group "${cmd.groupId}"`,
				);
			}
		}
	}
	// Children keep their transform local to the (about-to-vanish) group's
	// coordinate space today; spliced verbatim into the parent, they'd jump by
	// whatever the group's own transform was (C-4). Re-express each child's
	// transform relative to the parent instead, so its WORLD position (and
	// thus its render) is unchanged by the group going away.
	const spillChildren = children.map((child) => ({
		...child,
		transform: reprojectTransform(
			toAffineMatrix(group.transform),
			child.transform,
		),
	}));
	let next: CanvasIR;
	try {
		// Single tree rewrite: replace the group with its children spilled into the
		// parent — at their recorded indices when restoring, else contiguously at
		// the group's former slot.
		next = replaceChildrenInParent(ir, {
			parentId,
			replace: (siblings) => {
				const withoutGroup = siblings.filter((c) => c.id !== cmd.groupId);
				const result = [...withoutGroup];
				if (restore && restore.length > 0) {
					const plan = [...restore].sort((a, b) => a.index - b.index);
					for (const { id, index } of plan) {
						const child = spillChildren.find((c) => c.id === id);
						if (child) result.splice(index, 0, child);
					}
					return result;
				}
				result.splice(groupIndex, 0, ...spillChildren);
				return result;
			},
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeGroupCommand = {
		type: "node.group",
		...(found.page !== undefined ? { pageId: found.page.id } : {}),
		childIds,
		groupId: cmd.groupId,
		groupTemplate,
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function applyPageCreate(
	ir: CanvasIR,
	cmd: CanvasPageCreateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	if (ir.pages.some((p) => p.id === cmd.page.id)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Page id "${cmd.page.id}" already exists`,
		);
	}
	const insertIndex = cmd.index ?? ir.pages.length;
	if (insertIndex < 0 || insertIndex > ir.pages.length) {
		throw new CanvasCommandError(
			"index-out-of-range",
			`Insert index ${insertIndex} out of range for pages length ${ir.pages.length}`,
		);
	}
	const newPages = [...ir.pages];
	newPages.splice(insertIndex, 0, cmd.page);
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageDeleteCommand = {
		type: "page.delete",
		pageId: cmd.page.id,
	};
	return { ir: next, inverse };
}

function applyPageDelete(
	ir: CanvasIR,
	cmd: CanvasPageDeleteCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	if (idx < 0) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	// CanvasIRSchema requires pages.length >= 1 (a document with no pages has
	// nowhere for a root to live). Enforced here — not only in an Editor UI
	// guard — so every path that reaches this command (direct apply, a batch,
	// undo/redo replay, a host bypassing the Editor entirely) is protected.
	if (ir.pages.length <= 1) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Cannot delete page "${cmd.pageId}": a CanvasIR must have at least one page`,
		);
	}
	const removed = ir.pages[idx];
	if (!removed) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const newPages = ir.pages.filter((_, i) => i !== idx);
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageCreateCommand = {
		type: "page.create",
		page: removed,
		index: idx,
	};
	return { ir: next, inverse };
}

function applyPageRename(
	ir: CanvasIR,
	cmd: CanvasPageRenameCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	if (idx < 0) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const current = ir.pages[idx];
	if (!current) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const priorName = current.name;
	if (priorName !== cmd.from) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Page "${cmd.pageId}" name "${priorName ?? ""}" does not match expected "from" "${cmd.from ?? ""}"`,
		);
	}
	const renamed: CanvasPage =
		cmd.to === undefined
			? (() => {
					const { name: _omit, ...rest } = current;
					return rest as CanvasPage;
				})()
			: { ...current, name: cmd.to };
	const newPages = ir.pages.map((p, i) => (i === idx ? renamed : p));
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageRenameCommand = {
		type: "page.rename",
		pageId: cmd.pageId,
		from: cmd.to,
		to: priorName,
	};
	return { ir: next, inverse };
}

/**
 * Deep-clone a page's node tree with fresh ids and insert it immediately
 * after the source (§9.1/§23, PRD 0012). Page-level fields (`size`,
 * `background`, `layoutAids`, `variantSource`, `animation`) are carried over
 * by reference from the source page — safe because every other command
 * always replaces those fields wholesale rather than mutating them in place,
 * the same sharing `page.resize`'s `newPage` spread relies on. The inverse is
 * a `page.delete` for the assigned id: undo removes exactly the duplicate,
 * leaving the source and all other pages byte-for-byte untouched.
 */
function applyPageDuplicate(
	ir: CanvasIR,
	cmd: CanvasPageDuplicateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const sourceIndex = ir.pages.findIndex((p) => p.id === cmd.sourcePageId);
	const source = sourceIndex >= 0 ? ir.pages[sourceIndex] : undefined;
	if (!source) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.sourcePageId}" not found`,
		);
	}
	if (ir.pages.some((p) => p.id === cmd.newPageId)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Page id "${cmd.newPageId}" already exists`,
		);
	}
	const { node: newRoot } = regenerateNodeIds(source.root);
	const baseName = source.name ?? "Page";
	const newPage: CanvasPage = {
		...source,
		id: cmd.newPageId,
		name: cmd.name ?? `${baseName} copy`,
		root: newRoot,
	};
	const newPages = [...ir.pages];
	newPages.splice(sourceIndex + 1, 0, newPage);
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageDeleteCommand = {
		type: "page.delete",
		pageId: cmd.newPageId,
	};
	return { ir: next, inverse };
}

function applyPageReorder(
	ir: CanvasIR,
	cmd: CanvasPageReorderCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	if (idx < 0) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	if (idx !== cmd.from) {
		throw new CanvasCommandError(
			"index-out-of-range",
			`Page "${cmd.pageId}" is at index ${idx}, not ${cmd.from}`,
		);
	}
	const length = ir.pages.length;
	if (cmd.to < 0 || cmd.to >= length) {
		throw new CanvasCommandError(
			"index-out-of-range",
			`Reorder target index ${cmd.to} out of range for pages length ${length}`,
		);
	}
	const newPages = [...ir.pages];
	const [moved] = newPages.splice(cmd.from, 1);
	if (!moved) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Page splice returned undefined at index ${cmd.from}`,
		);
	}
	newPages.splice(cmd.to, 0, moved);
	const next = bumpMetadata({ ...ir, pages: newPages }, options);
	const inverse: CanvasPageReorderCommand = {
		type: "page.reorder",
		pageId: cmd.pageId,
		from: cmd.to,
		to: cmd.from,
	};
	return { ir: next, inverse };
}

/**
 * Apply a sequence of commands as one reversible unit. Folds `applyCommand`
 * over a local working IR (never touching the caller's `ir`), so a throw from
 * any sub-command leaves the input unchanged — all-or-nothing. The inverse is a
 * `batch` of the sub-inverses in reverse order, replayable through this same
 * `case "batch"` by undo/redo.
 */
function applyBatch(
	ir: CanvasIR,
	cmd: CanvasBatchCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	let working = ir;
	const inverses: CanvasCommand[] = [];
	for (const sub of cmd.commands) {
		// The core, not the settling wrapper: the whole batch settles Source
		// revisions once at ITS boundary (see `settleComponentRevisions`).
		const result = applyCommandCore(working, sub, options);
		working = result.ir;
		inverses.push(result.inverse);
	}
	inverses.reverse();
	const inverse: CanvasBatchCommand = {
		type: "batch",
		...(cmd.label !== undefined ? { label: cmd.label } : {}),
		commands: inverses,
	};
	return { ir: working, inverse };
}

function applyNodeReorder(
	ir: CanvasIR,
	cmd: CanvasNodeReorderCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const found = findNodeInScope(ir, cmd.nodeId, cmd.location);
	// Missing node and tree root fail identically (the legacy `parentOf`
	// contract): neither has a parent to reorder within.
	if (!found || !found.parent) {
		throw new CanvasCommandError(
			"parent-not-found",
			`Node "${cmd.nodeId}" has no parent (likely a page root)`,
		);
	}
	const parent = found.parent;
	const fromIndex = parent.children.findIndex((c) => c.id === cmd.nodeId);
	if (fromIndex < 0) {
		throw new CanvasCommandError(
			"node-not-found",
			`Node "${cmd.nodeId}" not found under parent "${parent.id}"`,
		);
	}
	const maxIndex = parent.children.length - 1;
	const toIndex = Math.max(0, Math.min(maxIndex, cmd.toIndex));
	let next: CanvasIR;
	try {
		next = reorderChildren(ir, {
			parentId: parent.id,
			fromIndex,
			toIndex,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeReorderCommand = {
		type: "node.reorder",
		nodeId: cmd.nodeId,
		toIndex: fromIndex,
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function applyNodeReparent(
	ir: CanvasIR,
	cmd: CanvasNodeReparentCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const found = findNodeInScope(ir, cmd.nodeId, cmd.location);
	if (!found || !found.parent) {
		throw new CanvasCommandError(
			"parent-not-found",
			`Node "${cmd.nodeId}" has no parent (missing, or a page root — page roots cannot be reparented)`,
		);
	}
	const fromParent = found.parent;
	const fromIndex = fromParent.children.findIndex((c) => c.id === cmd.nodeId);
	if (fromIndex < 0) {
		throw new CanvasCommandError(
			"node-not-found",
			`Node "${cmd.nodeId}" not found under parent "${fromParent.id}"`,
		);
	}
	const target = findNodeInScope(ir, cmd.toParentId, cmd.location);
	if (!target) {
		throw new CanvasCommandError(
			"parent-not-found",
			`New parent id "${cmd.toParentId}" not found`,
		);
	}
	if (!isContainerNode(target.node)) {
		throw new CanvasCommandError(
			"parent-not-group",
			`New parent "${cmd.toParentId}" is not a container (type=${target.node.type})`,
		);
	}
	// Clamp like node.reorder: a stale UI index degrades to an end insert
	// instead of throwing. When the node already lives in the target, the
	// mutation removes it before inserting, so the valid range shrinks by one.
	const targetLength =
		target.node.children.length - (fromParent.id === cmd.toParentId ? 1 : 0);
	const toIndex = Math.max(0, Math.min(targetLength, cmd.toIndex));
	let next: CanvasIR;
	try {
		next = moveNode(ir, {
			id: cmd.nodeId,
			newParentId: cmd.toParentId,
			index: toIndex,
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeReparentCommand = {
		type: "node.reparent",
		nodeId: cmd.nodeId,
		toParentId: fromParent.id,
		toIndex: fromIndex,
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function applyPageResize(
	ir: CanvasIR,
	cmd: CanvasPageResizeCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	const page = idx >= 0 ? ir.pages[idx] : undefined;
	if (!page) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const mode = cmd.mode ?? "canvas-only";
	// The inverse restores the ACTUAL prior size, even when cmd.from is stale.
	const prior = { width: page.size.width, height: page.size.height };
	const priorChildren = page.root.children;

	let children = priorChildren;
	// A zero-dimension prior page (the schema allows it) would otherwise divide
	// by zero below, writing Infinity/NaN into every child's transform — fall
	// back to leaving content untouched (canvas-only's behavior) instead (C-12).
	if (mode === "scale-content" && prior.width !== 0 && prior.height !== 0) {
		const s = Math.min(
			cmd.to.width / prior.width,
			cmd.to.height / prior.height,
		);
		children = priorChildren.map((child) => ({
			...child,
			transform: {
				...child.transform,
				x: child.transform.x * s,
				y: child.transform.y * s,
				scaleX: child.transform.scaleX * s,
				scaleY: child.transform.scaleY * s,
			},
		}));
	} else if (mode === "recenter") {
		const dx = (cmd.to.width - prior.width) / 2;
		const dy = (cmd.to.height - prior.height) / 2;
		children = priorChildren.map((child) => ({
			...child,
			transform: {
				...child.transform,
				x: child.transform.x + dx,
				y: child.transform.y + dy,
			},
		}));
	}

	const newPage: CanvasPage = {
		...page,
		// Width/height only — the page's existing `unit` is preserved (OD-1,
		// see docs/architecture/unit-dpi-export-only-decision.md: unit/dpi
		// are export-time-only and no command mutates them).
		size: { ...page.size, width: cmd.to.width, height: cmd.to.height },
		root: {
			...page.root,
			bounds: { width: cmd.to.width, height: cmd.to.height },
			children: [...children],
		},
	};
	const next = bumpMetadata(
		{ ...ir, pages: ir.pages.map((p, i) => (i === idx ? newPage : p)) },
		options,
	);

	// canvas-only and recenter invert exactly by symmetry; scale-content would
	// drift through a reciprocal scale, so its inverse restores the exact
	// prior transforms alongside the size.
	const inverse: CanvasCommand =
		mode === "scale-content"
			? {
					type: "batch",
					label: "Resize page",
					commands: [
						{
							type: "page.resize",
							pageId: cmd.pageId,
							from: { ...cmd.to },
							to: prior,
							mode: "canvas-only",
						},
						...priorChildren.map(
							(child): CanvasCommand =>
								({
									type: "node.update",
									nodeId: child.id,
									kind: child.type,
									patch: { transform: child.transform },
								}) as CanvasCommand,
						),
					],
				}
			: {
					type: "page.resize",
					pageId: cmd.pageId,
					from: { ...cmd.to },
					to: prior,
					mode,
				};
	return { ir: next, inverse };
}

function applyPageSetBackground(
	ir: CanvasIR,
	cmd: CanvasPageSetBackgroundCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	const page = idx >= 0 ? ir.pages[idx] : undefined;
	if (!page) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const prior = page.background;
	const newPage: CanvasPage = { ...page, background: cmd.to };
	const next = bumpMetadata(
		{ ...ir, pages: ir.pages.map((p, i) => (i === idx ? newPage : p)) },
		options,
	);
	const inverse: CanvasPageSetBackgroundCommand = {
		type: "page.set-background",
		pageId: cmd.pageId,
		from: cmd.to,
		to: prior,
	};
	return { ir: next, inverse };
}

function applyPageSetLayoutAids(
	ir: CanvasIR,
	cmd: CanvasPageSetLayoutAidsCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const idx = ir.pages.findIndex((p) => p.id === cmd.pageId);
	const page = idx >= 0 ? ir.pages[idx] : undefined;
	if (!page) {
		throw new CanvasCommandError(
			"page-not-found",
			`Page id "${cmd.pageId}" not found`,
		);
	}
	const prior = page.layoutAids;
	// Clearing drops the key entirely so a cleared page serializes identically
	// to one that never had layout aids.
	const { layoutAids: _prior, ...rest } = page;
	const newPage: CanvasPage =
		cmd.to === undefined ? { ...rest } : { ...rest, layoutAids: cmd.to };
	const next = bumpMetadata(
		{ ...ir, pages: ir.pages.map((p, i) => (i === idx ? newPage : p)) },
		options,
	);
	const inverse: CanvasPageSetLayoutAidsCommand = {
		type: "page.set-layout-aids",
		pageId: cmd.pageId,
		from: cmd.to,
		to: prior,
	};
	return { ir: next, inverse };
}

function applyAssetPut(
	ir: CanvasIR,
	cmd: CanvasAssetPutCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const previous = ir.assets[cmd.asset.id];
	const next: CanvasIR = bumpMetadata(
		{ ...ir, assets: { ...ir.assets, [cmd.asset.id]: cmd.asset } },
		options,
	);
	const inverse: CanvasCommand = previous
		? { type: "asset.put", asset: previous }
		: { type: "asset.remove", assetId: cmd.asset.id };
	return { ir: next, inverse };
}

function applyAssetRemove(
	ir: CanvasIR,
	cmd: CanvasAssetRemoveCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const previous = ir.assets[cmd.assetId];
	if (!previous) {
		throw new CanvasCommandError(
			"asset-not-found",
			`Asset id "${cmd.assetId}" not found`,
		);
	}
	const assets = { ...ir.assets };
	delete assets[cmd.assetId];
	const next: CanvasIR = bumpMetadata({ ...ir, assets }, options);
	const inverse: CanvasAssetPutCommand = {
		type: "asset.put",
		asset: previous,
	};
	return { ir: next, inverse };
}

// ---------------------------------------------------------------------------
// Local Components — registry + instance command handlers (plan 0023 M3-02).
// ---------------------------------------------------------------------------

function expectDefinition(
	ir: CanvasIR,
	componentId: string,
): CanvasComponentDefinition {
	const definition = ir.components?.[componentId];
	if (!definition) {
		throw new CanvasCommandError(
			"location-not-found",
			`Component definition "${componentId}" not found`,
		);
	}
	return definition;
}

/**
 * Rewrite one Registry entry (metadata edits like rename). Content edits to
 * a Source TREE go through the scoped mutation engine instead — this is only
 * for definition-level fields the tree engine cannot express.
 */
function withDefinition(
	ir: CanvasIR,
	componentId: string,
	definition: CanvasComponentDefinition,
	options: CommandApplyOptions,
): CanvasIR {
	return bumpMetadata(
		{
			...ir,
			components: { ...ir.components, [componentId]: definition },
		},
		options,
	);
}

/** Every node id used anywhere in the document — pages and Source trees. */
function collectDocumentNodeIds(ir: CanvasIR): Set<string> {
	const ids = new Set<string>();
	walkDocument(ir, ({ node }) => {
		ids.add(node.id);
	});
	return ids;
}

/**
 * Reject a registry write that would break the component graph: a duplicate
 * definition id, colliding Source node ids (INV-2), a dependency cycle, or
 * an over-deep nested chain (LC-GRAPH: reject on write).
 */
function assertRegistryAddable(
	ir: CanvasIR,
	definition: CanvasComponentDefinition,
): void {
	if (ir.components?.[definition.id]) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Component id "${definition.id}" already exists`,
		);
	}
	if (
		Object.keys(ir.components ?? {}).length >=
		MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT
	) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Registry is full: MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT (${MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT})`,
		);
	}
	const existingIds = collectDocumentNodeIds(ir);
	const incoming = findDuplicateSourceNodeId(definition.root, existingIds);
	if (incoming) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Source node id "${incoming}" already exists elsewhere in the document (INV-2)`,
		);
	}
	const graph = buildComponentGraph({
		...ir.components,
		[definition.id]: definition,
	});
	if (graph.cycles.length > 0) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Adding component "${definition.id}" would create a dependency cycle: ${graph.cycles[0]?.join(" → ")}`,
		);
	}
	if (graph.depthExceeded.length > 0) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Adding component "${definition.id}" would exceed the nested-component depth cap`,
		);
	}
}

function findDuplicateSourceNodeId(
	root: CanvasNode,
	existing: ReadonlySet<string>,
	depth = 0,
): string | null {
	if (depth > MAX_TREE_DEPTH) return null;
	if (existing.has(root.id)) return root.id;
	if (isContainerNode(root)) {
		for (const child of root.children) {
			const hit = findDuplicateSourceNodeId(child, existing, depth + 1);
			if (hit) return hit;
		}
	}
	return null;
}

function applyComponentCreate(
	ir: CanvasIR,
	cmd: CanvasComponentCreateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	if (cmd.mode !== "restore") {
		return applyComponentCreateFromSelection(ir, cmd, options);
	}
	assertRegistryAddable(ir, cmd.definition);
	const next = withDefinition(ir, cmd.definition.id, cmd.definition, options);
	const inverse: CanvasComponentDeleteCommand = {
		type: "component.delete",
		componentId: cmd.definition.id,
	};
	return { ir: next, inverse };
}

const IDENTITY_TRANSFORM: CanvasTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

/**
 * M3-04 + M3-05: turn a same-parent selection into a Component Source plus
 * its first instance, atomically, with visual placement unchanged (AC-001).
 *
 * Root strategy: a single selected group/frame is PROMOTED to the Source
 * root (its transform moves onto the instance; the resolver composes the
 * instance placement over the root, so parity is exact). A leaf or
 * multi-selection is WRAPPED in a new frame at the selection's tight
 * parent-local AABB, children re-expressed frame-locally in paint order —
 * Auto Layout is never inferred (LC-CREATE-001).
 *
 * Source node ids are remapped via `regenerateNodeIds` (INV-2); the root
 * takes the caller-allocated `sourceRootId`, and the caller also allocates
 * `componentId`/`firstInstanceId`, so replay is deterministic at every
 * externally-referenced id. Validation of the final component graph runs
 * AFTER the instance is placed, so a create inside a Source tree that would
 * close a dependency cycle is rejected whole (nothing escapes — the input
 * document is never mutated).
 */
function applyComponentCreateFromSelection(
	ir: CanvasIR,
	cmd: Extract<CanvasComponentCreateCommand, { mode: "from-selection" }>,
	options: CommandApplyOptions,
): CommandApplyResult {
	if (cmd.selectedNodeIds.length === 0) {
		throw new CanvasCommandError(
			"invariant-violated",
			"component.create requires at least one selected node",
		);
	}
	if (new Set(cmd.selectedNodeIds).size !== cmd.selectedNodeIds.length) {
		throw new CanvasCommandError(
			"invariant-violated",
			"component.create selectedNodeIds contains duplicates",
		);
	}
	// Resolve the tree the selection lives in: explicit, or the page holding
	// the first selected node.
	let location = cmd.location;
	if (!location) {
		const first = cmd.selectedNodeIds[0] as string;
		const page = ir.pages.find((p) => findNodeInSubtree(p.root, first));
		if (!page) {
			throw new CanvasCommandError(
				"node-not-found",
				`Node id "${first}" not found on any page`,
			);
		}
		location = { kind: "page", id: page.id };
	}
	const scopeRoot = resolveScopeRoot(ir, location);
	// Same-parent validation (the node.group contract): one parent, sibling
	// set — which also excludes ancestor/descendant pairs by construction.
	let parent: CanvasContainerNode | undefined;
	const entries: GroupChildEntry[] = [];
	for (const id of cmd.selectedNodeIds) {
		assertUnlocked(ir, id, options, location);
		const found = findNodeInSubtree(scopeRoot, id);
		if (!found) {
			throw new CanvasCommandError(
				"node-not-found",
				`Node "${id}" not found in ${location.kind} "${location.id}"`,
			);
		}
		if (!found.parent) {
			throw new CanvasCommandError(
				"invariant-violated",
				`Cannot create a component from tree root "${id}"`,
			);
		}
		if (parent === undefined) {
			parent = found.parent;
		} else if (parent.id !== found.parent.id) {
			throw new CanvasCommandError(
				"invariant-violated",
				"component.create requires all selected nodes to share the same parent",
			);
		}
		const index = found.parent.children.findIndex((c) => c.id === id);
		entries.push({ id, node: found.node, index });
	}
	if (parent === undefined) {
		throw new CanvasCommandError(
			"invariant-violated",
			"component.create could not resolve a parent",
		);
	}
	entries.sort((a, b) => a.index - b.index);
	const minIndex = (entries[0] as GroupChildEntry).index;
	// Caller-allocated ids must be globally fresh — simpler and stricter than
	// "fresh after the selection vanishes", and what an id factory produces
	// anyway.
	const currentIds = collectDocumentNodeIds(ir);
	for (const [label, id] of [
		["firstInstanceId", cmd.firstInstanceId],
		["sourceRootId", cmd.sourceRootId],
	] as const) {
		if (currentIds.has(id)) {
			throw new CanvasCommandError(
				"invariant-violated",
				`component.create ${label} "${id}" already exists in the document`,
			);
		}
	}

	const single = entries.length === 1 ? (entries[0] as GroupChildEntry) : null;
	const singleContainer =
		single && isContainerNode(single.node) ? single.node : null;
	const strategy =
		cmd.rootStrategy ?? (singleContainer ? "reuse-container" : "wrap-in-frame");

	let sourceRootDraft: CanvasNode;
	let instanceTransform: Partial<CanvasTransform>;
	let instanceBounds: CanvasBounds;
	let instanceZIndex: number;
	let instanceLayoutItem = singleContainer?.layoutItem;
	if (strategy === "reuse-container") {
		if (!singleContainer) {
			throw new CanvasCommandError(
				"invariant-violated",
				"rootStrategy reuse-container requires exactly one selected group/frame",
			);
		}
		// The container's placement moves onto the instance; the Source root is
		// normalized to identity (the resolver overwrites root transform/bounds
		// with the instance's — §9.3). Its slot in a parent Auto Layout
		// (`layoutItem`) belongs to the instance, not the Source.
		const { layoutItem: _lifted, ...rest } = singleContainer;
		sourceRootDraft = { ...rest, transform: IDENTITY_TRANSFORM };
		instanceTransform = singleContainer.transform;
		instanceBounds = singleContainer.bounds;
		instanceZIndex = singleContainer.zIndex ?? 0;
	} else {
		// Tight parent-local AABB (transform-aware) — NOT the origin-anchored
		// children-bounds used by node.group, which would inflate the frame.
		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;
		for (const entry of entries) {
			const ext = transformedBoundsExtent(
				entry.node.transform,
				entry.node.bounds.width,
				entry.node.bounds.height,
			);
			if (ext.minX < minX) minX = ext.minX;
			if (ext.minY < minY) minY = ext.minY;
			if (ext.maxX > maxX) maxX = ext.maxX;
			if (ext.maxY > maxY) maxY = ext.maxY;
		}
		instanceBounds = { width: maxX - minX, height: maxY - minY };
		instanceTransform = { x: minX, y: minY };
		instanceZIndex = 0;
		instanceLayoutItem = undefined;
		// Children re-expressed frame-locally, in sibling paint order; Auto
		// Layout is never inferred (the wrap frame is a plain frame).
		sourceRootDraft = createFrame({
			id: cmd.sourceRootId,
			bounds: instanceBounds,
			children: entries.map((entry) => ({
				...entry.node,
				transform: {
					...entry.node.transform,
					x: entry.node.transform.x - minX,
					y: entry.node.transform.y - minY,
				},
			})),
		});
	}
	// Fresh Source node ids (INV-2), then pin the root to the caller's id.
	const { node: remappedRoot } = regenerateNodeIds(sourceRootDraft);
	const sourceRoot: CanvasNode = { ...remappedRoot, id: cmd.sourceRootId };
	const definition: CanvasComponentDefinition = {
		id: cmd.componentId,
		name: cmd.name ?? "Component",
		revision: 1,
		root: sourceRoot,
		properties: [],
	};

	const instance = createComponentInstance({
		id: cmd.firstInstanceId,
		componentId: cmd.componentId,
		bounds: instanceBounds,
		transform: instanceTransform,
		zIndex: instanceZIndex,
		...(instanceLayoutItem !== undefined
			? { layoutItem: instanceLayoutItem }
			: {}),
	});
	const selectedIds = new Set(cmd.selectedNodeIds);
	let working: CanvasIR;
	try {
		// One tree rewrite: drop the selection, splice the instance into the
		// topmost selected slot (the node.group convention).
		working = replaceChildrenInParent(ir, {
			parentId: parent.id,
			replace: (children) => {
				const remaining = children.filter((c) => !selectedIds.has(c.id));
				remaining.splice(minIndex, 0, instance);
				return remaining;
			},
			location,
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	// Validate against the POST-placement document: node-id freshness for the
	// definition, and the full dependency graph including the edge the new
	// instance just added (a create inside a Source tree can close a cycle).
	assertRegistryAddable(working, definition);
	const next = withDefinition(working, cmd.componentId, definition, options);

	const inverse: CanvasBatchCommand = {
		type: "batch",
		commands: [
			{
				type: "node.delete",
				nodeId: cmd.firstInstanceId,
				...(location !== undefined ? { location } : {}),
			},
			...entries.map(
				(entry): CanvasNodeCreateCommand => ({
					type: "node.create",
					node: entry.node,
					...(location.kind === "page" ? { pageId: location.id } : {}),
					parentId: (parent as CanvasContainerNode).id,
					index: entry.index,
					location,
				}),
			),
			{ type: "component.delete", componentId: cmd.componentId },
		],
	};
	return { ir: next, inverse };
}

function applyComponentRename(
	ir: CanvasIR,
	cmd: CanvasComponentRenameCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const definition = expectDefinition(ir, cmd.componentId);
	const next = withDefinition(
		ir,
		cmd.componentId,
		{
			...definition,
			name: cmd.to,
			revision: cmd.revision ?? definition.revision + 1,
		},
		options,
	);
	const inverse: CanvasComponentRenameCommand = {
		type: "component.rename",
		componentId: cmd.componentId,
		from: cmd.to,
		to: definition.name,
		revision: definition.revision,
	};
	return { ir: next, inverse };
}

function applyComponentDuplicate(
	ir: CanvasIR,
	cmd: CanvasComponentDuplicateCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const definition = expectDefinition(ir, cmd.componentId);
	const { node: newRoot, idMap } = regenerateNodeIds(definition.root);
	const duplicated: CanvasComponentDefinition = {
		id: cmd.newComponentId,
		name: cmd.name ?? `${definition.name} copy`,
		// A fresh definition with no dependents starts its own revision line.
		revision: 1,
		root: newRoot,
		// Property IDs are kept (cross-definition reuse is permitted, TD §5.5);
		// bindings follow the remapped Source node ids.
		properties: definition.properties.map((property) => ({
			...property,
			nodeId: idMap.get(property.nodeId) ?? property.nodeId,
		})),
	};
	assertRegistryAddable(ir, duplicated);
	const next = withDefinition(ir, cmd.newComponentId, duplicated, options);
	const inverse: CanvasComponentDeleteCommand = {
		type: "component.delete",
		componentId: cmd.newComponentId,
	};
	return { ir: next, inverse };
}

/** Where instances of `componentId` still live (page trees and Source trees). */
function findComponentReferences(
	ir: CanvasIR,
	componentId: string,
): { count: number; locations: string[] } {
	const locations: string[] = [];
	walkDocument(ir, ({ node, location }) => {
		if (
			node.type === "component-instance" &&
			node.componentId === componentId
		) {
			locations.push(`${location.kind}:${location.id}`);
		}
	});
	return { count: locations.length, locations };
}

function applyComponentDelete(
	ir: CanvasIR,
	cmd: CanvasComponentDeleteCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const definition = expectDefinition(ir, cmd.componentId);
	const references = findComponentReferences(ir, cmd.componentId);
	if (references.count > 0) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Component "${cmd.componentId}" still has ${references.count} reference(s) (${references.locations.join(", ")}) — detach or delete them first (LC-DELETE)`,
		);
	}
	const { [cmd.componentId]: _removed, ...remaining } = ir.components ?? {};
	const base = bumpMetadata(ir, options);
	// INV-10: an empty Registry is normalized to an ABSENT `components` key.
	const { components: _components, ...withoutRegistry } = base;
	const next: CanvasIR =
		Object.keys(remaining).length > 0
			? { ...base, components: remaining }
			: withoutRegistry;
	const inverse: CanvasComponentCreateCommand = {
		type: "component.create",
		mode: "restore",
		definition,
	};
	return { ir: next, inverse };
}

/**
 * Reject a property whose binding is invalid against the CURRENT Source tree
 * (M3-06 reject-on-write): the target node must exist in the definition and
 * accept the property's kind (§10.1) — the same table the read-side
 * validator applies.
 */
function assertPropertyBindable(
	definition: CanvasComponentDefinition,
	property: CanvasComponentProperty,
): void {
	const target = findNodeInSubtree(definition.root, property.nodeId);
	if (!target) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Property "${property.id}" targets node "${property.nodeId}", which is not in component "${definition.id}"'s Source tree`,
		);
	}
	if (!propertyTargetsNode(property, target.node)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Property "${property.id}" (${property.kind}) cannot bind node "${target.node.id}" ("${target.node.type}")`,
		);
	}
}

function applyComponentAddProperty(
	ir: CanvasIR,
	cmd: CanvasComponentAddPropertyCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const definition = expectDefinition(ir, cmd.componentId);
	if (definition.properties.some((p) => p.id === cmd.property.id)) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Property id "${cmd.property.id}" already exists on component "${cmd.componentId}"`,
		);
	}
	if (definition.properties.length >= MAX_COMPONENT_PROPERTIES_PER_COMPONENT) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Component "${cmd.componentId}" would exceed MAX_COMPONENT_PROPERTIES_PER_COMPONENT (${MAX_COMPONENT_PROPERTIES_PER_COMPONENT})`,
		);
	}
	assertPropertyBindable(definition, cmd.property);
	const at = cmd.index ?? definition.properties.length;
	if (at < 0 || at > definition.properties.length) {
		throw new CanvasCommandError(
			"index-out-of-range",
			`Property index ${at} out of range for ${definition.properties.length} properties`,
		);
	}
	const properties = [...definition.properties];
	properties.splice(at, 0, cmd.property);
	const next = withDefinition(
		ir,
		cmd.componentId,
		{
			...definition,
			properties,
			revision: cmd.revision ?? definition.revision + 1,
		},
		options,
	);
	const inverse: CanvasComponentRemovePropertyCommand = {
		type: "component.remove-property",
		componentId: cmd.componentId,
		propertyId: cmd.property.id,
		revision: definition.revision,
	};
	return { ir: next, inverse };
}

function applyComponentUpdateProperty(
	ir: CanvasIR,
	cmd: CanvasComponentUpdatePropertyCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const definition = expectDefinition(ir, cmd.componentId);
	if (cmd.to.id !== cmd.propertyId) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Property IDs are stable (INV-6): cannot rewrite "${cmd.propertyId}" to "${cmd.to.id}"`,
		);
	}
	const at = definition.properties.findIndex((p) => p.id === cmd.propertyId);
	const prior = definition.properties[at];
	if (at < 0 || !prior) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Property "${cmd.propertyId}" not found on component "${cmd.componentId}"`,
		);
	}
	assertPropertyBindable(definition, cmd.to);
	const properties = [...definition.properties];
	properties[at] = cmd.to;
	const next = withDefinition(
		ir,
		cmd.componentId,
		{
			...definition,
			properties,
			revision: cmd.revision ?? definition.revision + 1,
		},
		options,
	);
	const inverse: CanvasComponentUpdatePropertyCommand = {
		type: "component.update-property",
		componentId: cmd.componentId,
		propertyId: cmd.propertyId,
		to: prior,
		revision: definition.revision,
	};
	return { ir: next, inverse };
}

function applyComponentRemoveProperty(
	ir: CanvasIR,
	cmd: CanvasComponentRemovePropertyCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	const definition = expectDefinition(ir, cmd.componentId);
	const at = definition.properties.findIndex((p) => p.id === cmd.propertyId);
	const prior = definition.properties[at];
	if (at < 0 || !prior) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Property "${cmd.propertyId}" not found on component "${cmd.componentId}"`,
		);
	}
	// Instance override maps are deliberately untouched: entries for this id
	// become orphans, retained verbatim (§10.3).
	const properties = definition.properties.filter(
		(p) => p.id !== cmd.propertyId,
	);
	const next = withDefinition(
		ir,
		cmd.componentId,
		{
			...definition,
			properties,
			revision: cmd.revision ?? definition.revision + 1,
		},
		options,
	);
	const inverse: CanvasComponentAddPropertyCommand = {
		type: "component.add-property",
		componentId: cmd.componentId,
		property: prior,
		index: at,
		revision: definition.revision,
	};
	return { ir: next, inverse };
}

/**
 * TD §5.2: a `locked` node inside a Source makes its exposed properties
 * READ-ONLY in every instance — under `enforceLocked`, override writes bound
 * to that node are typed `node-locked` errors. Orphan overrides (no matching
 * property) have no bound node and are not lock-protected. Independent of
 * the instance node's own lock, which `assertUnlocked` covers.
 */
function assertPropertyWritable(
	ir: CanvasIR,
	instance: CanvasComponentInstanceNode,
	propertyId: string,
	options: CommandApplyOptions,
): void {
	if (options.enforceLocked !== true) return;
	const definition = ir.components?.[instance.componentId];
	if (!definition) return;
	const property = definition.properties.find((p) => p.id === propertyId);
	if (!property) return;
	const target = findNodeInSubtree(definition.root, property.nodeId);
	if (target?.node.locked === true) {
		throw new CanvasCommandError(
			"node-locked",
			`Property "${propertyId}" binds locked Source node "${property.nodeId}" of component "${instance.componentId}" — read-only in every instance (enforceLocked)`,
		);
	}
}

function applyComponentInstanceInsert(
	ir: CanvasIR,
	cmd: CanvasComponentInstanceInsertCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	// The boundary where a broken reference is prevented: inserting an
	// instance of an unknown Source is a typed error, never a silent
	// placeholder-to-be.
	expectDefinition(ir, cmd.componentId);
	const node = createComponentInstance({
		id: cmd.instanceId,
		componentId: cmd.componentId,
		bounds: cmd.bounds,
		...(cmd.transform !== undefined ? { transform: cmd.transform } : {}),
		...(cmd.overrides !== undefined ? { overrides: cmd.overrides } : {}),
		...(cmd.name !== undefined ? { name: cmd.name } : {}),
		...(cmd.layoutItem !== undefined ? { layoutItem: cmd.layoutItem } : {}),
	});
	const parentId = resolveParentId(ir, cmd);
	let next: CanvasIR;
	try {
		next = insertNode(ir, {
			parentId,
			node,
			...(cmd.index !== undefined ? { index: cmd.index } : {}),
			...locationSpread(cmd),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
	const inverse: CanvasNodeDeleteCommand = {
		type: "node.delete",
		nodeId: cmd.instanceId,
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function expectInstanceNode(
	ir: CanvasIR,
	nodeId: string,
	location: CanvasDocumentLocation | undefined,
): CanvasComponentInstanceNode {
	const found = findNodeInScope(ir, nodeId, location);
	if (!found) {
		throw new CanvasCommandError(
			"node-not-found",
			`Node id "${nodeId}" not found`,
		);
	}
	if (found.node.type !== "component-instance") {
		throw new CanvasCommandError(
			"kind-mismatch",
			`Node "${nodeId}" is of kind "${found.node.type}", not "component-instance"`,
		);
	}
	return found.node;
}

function writeOverrideMap(
	ir: CanvasIR,
	nodeId: string,
	overrides: CanvasComponentOverrideMap | undefined,
	location: CanvasDocumentLocation | undefined,
	options: CommandApplyOptions,
): CanvasIR {
	try {
		return updateNode<"component-instance">(ir, {
			id: nodeId,
			// `undefined` deletes the key (mergeNodePatch), so an emptied map
			// normalizes back to an absent `overrides` field.
			patch: { overrides },
			...(location !== undefined ? { location } : {}),
			now: options.now,
		});
	} catch (err) {
		rethrowMutationError(err);
	}
}

function applyComponentInstanceSetOverride(
	ir: CanvasIR,
	cmd: CanvasComponentInstanceSetOverrideCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const node = expectInstanceNode(ir, cmd.nodeId, cmd.location);
	assertPropertyWritable(ir, node, cmd.propertyId, options);
	const prior = node.overrides?.[cmd.propertyId];
	const nextMap: CanvasComponentOverrideMap = {
		...node.overrides,
		[cmd.propertyId]: cmd.value,
	};
	if (Object.keys(nextMap).length > MAX_COMPONENT_OVERRIDES_PER_INSTANCE) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Instance "${cmd.nodeId}" would exceed MAX_COMPONENT_OVERRIDES_PER_INSTANCE (${MAX_COMPONENT_OVERRIDES_PER_INSTANCE})`,
		);
	}
	const next = writeOverrideMap(ir, cmd.nodeId, nextMap, cmd.location, options);
	const inverse:
		| CanvasComponentInstanceSetOverrideCommand
		| CanvasComponentInstanceResetOverrideCommand = prior
		? {
				type: "component-instance.set-override",
				nodeId: cmd.nodeId,
				propertyId: cmd.propertyId,
				value: prior,
				...locationSpread(cmd),
			}
		: {
				type: "component-instance.reset-override",
				nodeId: cmd.nodeId,
				propertyId: cmd.propertyId,
				...locationSpread(cmd),
			};
	return { ir: next, inverse };
}

function applyComponentInstanceResetOverride(
	ir: CanvasIR,
	cmd: CanvasComponentInstanceResetOverrideCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const node = expectInstanceNode(ir, cmd.nodeId, cmd.location);
	assertPropertyWritable(ir, node, cmd.propertyId, options);
	const prior = node.overrides?.[cmd.propertyId];
	if (prior === undefined) {
		// Resetting an absent key is a validated no-op (the instance exists and
		// is an instance); the inverse is the same no-op.
		return { ir, inverse: cmd };
	}
	const { [cmd.propertyId]: _removed, ...remaining } = node.overrides ?? {};
	const nextMap = Object.keys(remaining).length > 0 ? remaining : undefined;
	const next = writeOverrideMap(ir, cmd.nodeId, nextMap, cmd.location, options);
	const inverse: CanvasComponentInstanceSetOverrideCommand = {
		type: "component-instance.set-override",
		nodeId: cmd.nodeId,
		propertyId: cmd.propertyId,
		value: prior,
		...locationSpread(cmd),
	};
	return { ir: next, inverse };
}

function applyComponentInstanceResetAllOverrides(
	ir: CanvasIR,
	cmd: CanvasComponentInstanceResetAllOverridesCommand,
	options: CommandApplyOptions,
): CommandApplyResult {
	assertUnlocked(ir, cmd.nodeId, options, cmd.location);
	const node = expectInstanceNode(ir, cmd.nodeId, cmd.location);
	const prior = node.overrides;
	if (prior === undefined || Object.keys(prior).length === 0) {
		return { ir, inverse: cmd };
	}
	// All-or-nothing: one read-only (locked-bound) override blocks the whole
	// reset rather than a partial clear.
	for (const propertyId of Object.keys(prior)) {
		assertPropertyWritable(ir, node, propertyId, options);
	}
	const next = writeOverrideMap(
		ir,
		cmd.nodeId,
		undefined,
		cmd.location,
		options,
	);
	const inverse = {
		type: "node.update",
		nodeId: cmd.nodeId,
		kind: "component-instance",
		patch: { overrides: prior },
		...locationSpread(cmd),
	} as CanvasAnyNodeUpdateCommand;
	return { ir: next, inverse };
}

/**
 * Bump each touched Source's `revision` exactly once for one applied
 * command/batch/transaction (plan 0023 M3-02, LC-PROPAGATE).
 *
 * "Touched" is detected structurally: mutations are immutable with
 * structural sharing, so a definition whose reference survived was not
 * edited. A definition whose reference changed while its `revision` stayed
 * the same had tree/content edits that no handler versioned — those get the
 * single top-level bump. A handler that already managed `revision` itself
 * (the registry commands) is skipped, so a mixed batch still increments
 * exactly once overall.
 *
 * Undo/redo route through here like any other application, so undoing a
 * Source edit bumps the revision AGAIN (monotonic) — propagation must fire
 * for the restored content exactly as it did for the edit.
 */
export function settleComponentRevisions(
	before: CanvasIR,
	after: CanvasIR,
): CanvasIR {
	const prevRegistry = before.components;
	const nextRegistry = after.components;
	if (!nextRegistry || prevRegistry === nextRegistry) return after;
	let changed = false;
	const settled: Record<string, CanvasComponentDefinition> = {};
	for (const [id, definition] of Object.entries(nextRegistry)) {
		if (!definition) continue;
		const prev = prevRegistry?.[id];
		if (prev && prev !== definition && prev.revision === definition.revision) {
			settled[id] = { ...definition, revision: definition.revision + 1 };
			changed = true;
		} else {
			settled[id] = definition;
		}
	}
	return changed ? { ...after, components: settled } : after;
}

/**
 * The non-settling application primitive: applies `cmd` and returns the
 * inverse WITHOUT the once-per-application Source-revision settle. Every
 * composition wrapper (`batch` sub-commands here, `applyCommands` in
 * `transaction.ts`) folds over THIS and settles once at its own boundary —
 * calling the settling `applyCommand` per sub-command would bump a Source
 * once per sub-command instead of once per undoable unit. Use
 * `applyCommand` unless you are building such a wrapper.
 */
export function applyCommandCore(
	ir: CanvasIR,
	cmd: CanvasCommand,
	options: CommandApplyOptions = {},
): CommandApplyResult {
	switch (cmd.type) {
		case "node.create":
			return applyNodeCreate(ir, cmd, options);
		case "node.delete":
			return applyNodeDelete(ir, cmd, options);
		case "node.reorder":
			return applyNodeReorder(ir, cmd, options);
		case "node.reparent":
			return applyNodeReparent(ir, cmd, options);
		case "node.move":
			return applyNodeMove(ir, cmd, options);
		case "node.resize":
			return applyNodeResize(ir, cmd, options);
		case "node.rotate":
			return applyNodeRotate(ir, cmd, options);
		case "node.update":
			return applyNodeUpdate(ir, cmd, options);
		case "node.applyStyle":
			return applyNodeApplyStyle(ir, cmd, options);
		case "image.replace":
			return applyImageReplace(ir, cmd, options);
		case "node.group":
			return applyNodeGroup(ir, cmd, options);
		case "node.ungroup":
			return applyNodeUngroup(ir, cmd, options);
		case "frame.set-layout":
			return applyFrameSetLayout(ir, cmd, options);
		case "frame.remove-layout":
			return applyFrameRemoveLayout(ir, cmd, options);
		case "selection.wrap-in-layout-frame":
			return applyWrapInLayoutFrame(ir, cmd, options);
		case "page.create":
			return applyPageCreate(ir, cmd, options);
		case "page.delete":
			return applyPageDelete(ir, cmd, options);
		case "page.reorder":
			return applyPageReorder(ir, cmd, options);
		case "page.rename":
			return applyPageRename(ir, cmd, options);
		case "page.duplicate":
			return applyPageDuplicate(ir, cmd, options);
		case "page.resize":
			return applyPageResize(ir, cmd, options);
		case "page.set-background":
			return applyPageSetBackground(ir, cmd, options);
		case "page.set-layout-aids":
			return applyPageSetLayoutAids(ir, cmd, options);
		case "asset.put":
			return applyAssetPut(ir, cmd, options);
		case "asset.remove":
			return applyAssetRemove(ir, cmd, options);
		case "component.create":
			return applyComponentCreate(ir, cmd, options);
		case "component.rename":
			return applyComponentRename(ir, cmd, options);
		case "component.duplicate":
			return applyComponentDuplicate(ir, cmd, options);
		case "component.delete":
			return applyComponentDelete(ir, cmd, options);
		case "component.add-property":
			return applyComponentAddProperty(ir, cmd, options);
		case "component.update-property":
			return applyComponentUpdateProperty(ir, cmd, options);
		case "component.remove-property":
			return applyComponentRemoveProperty(ir, cmd, options);
		case "component-instance.insert":
			return applyComponentInstanceInsert(ir, cmd, options);
		case "component-instance.set-override":
			return applyComponentInstanceSetOverride(ir, cmd, options);
		case "component-instance.reset-override":
			return applyComponentInstanceResetOverride(ir, cmd, options);
		case "component-instance.reset-all-overrides":
			return applyComponentInstanceResetAllOverrides(ir, cmd, options);
		case "batch":
			return applyBatch(ir, cmd, options);
		default:
			// `cmd` is statically exhaustive above; this guards untrusted/cast
			// input (e.g. an AI-provider payload) whose `type` matches no known
			// command instead of silently returning `undefined` (P1 C-2).
			throw new CanvasCommandError(
				"unknown-command",
				`Unrecognized command type "${(cmd as { type: string }).type}"`,
			);
	}
}

/**
 * Apply one command (including a whole `batch`) and settle Source revisions
 * once — the entry point everything user-facing goes through.
 */
export function applyCommand(
	ir: CanvasIR,
	cmd: CanvasCommand,
	options: CommandApplyOptions = {},
): CommandApplyResult {
	const result = applyCommandCore(ir, cmd, options);
	return {
		ir: settleComponentRevisions(ir, result.ir),
		inverse: result.inverse,
	};
}
