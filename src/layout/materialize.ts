import type {
	CanvasIR,
	CanvasLayoutMaterialization,
	CanvasNode,
	CanvasPage,
} from "../ir/types.js";
import {
	computeInputHash,
	resolutionManifestHash,
	resolveCanvasLayout,
} from "./resolve.js";
import type {
	CanvasLayoutResolveOptions,
	CanvasResolvedDocument,
} from "./types.js";
import { toResolvedNodeId } from "./types.js";

/**
 * @file Materialization and flatten (TD §5.3, T-M2-08).
 *
 * Two related but opposite operations on the same resolved tree:
 *
 * - **Materialize** writes resolved geometry back into the document *while
 *   keeping the intent*, and stamps it. The geometry becomes a discardable
 *   cache that an offline or pre-v3 consumer can render from — the intent
 *   stays authoritative.
 * - **Flatten** writes the same geometry and *removes* the intent. The result
 *   is an ordinary absolute-positioned document that renders identically and
 *   has no Auto Layout at all.
 *
 * The distinction matters for rollback (PRD §19): flatten is an explicit,
 * destructive user action that must produce a NEW document or revision, never
 * overwrite the original, because the intent it discards cannot be recovered
 * from the geometry it leaves behind.
 */

/** Replace one node's geometry from the resolved tree, recursively. */
function writeGeometry(
	node: CanvasNode,
	resolved: CanvasResolvedDocument,
	stripIntent: boolean,
): CanvasNode {
	const record = resolved.records.get(toResolvedNodeId(node.id));
	const children = (node as { children?: readonly CanvasNode[] }).children;
	const next: Record<string, unknown> = { ...node };

	if (record) {
		next.transform = record.geometry.localTransform;
		next.bounds = record.geometry.bounds;
	}
	if (stripIntent) {
		// Deleted, not set to `undefined`: a document round-tripping through
		// `JSON.stringify` would keep an explicit `undefined` out anyway, but an
		// in-memory consumer testing `"autoLayout" in node` must also see it
		// gone, and that is the check that decides whether a frame is an Auto
		// Layout container.
		delete next.autoLayout;
		delete next.layoutItem;
	}
	if (children) {
		next.children = children.map((child) =>
			writeGeometry(child, resolved, stripIntent),
		);
	}
	// Double cast, deliberately. `CanvasNode` is a 15-member discriminated
	// union and this function rewrites fields on whichever member it was
	// handed; TypeScript cannot follow a spread-plus-delete through a union
	// back to the same member. Only geometry fields present on `CanvasNodeBase`
	// are written and only optional layout fields are removed, so the
	// discriminant and every kind-specific field survive untouched — which is
	// what makes the cast safe rather than merely quiet.
	return next as unknown as CanvasNode;
}

function writePage(
	page: CanvasPage,
	resolved: CanvasResolvedDocument,
	stripIntent: boolean,
): CanvasPage {
	return {
		...page,
		root: writeGeometry(page.root, resolved, stripIntent) as CanvasPage["root"],
	};
}

export interface CanvasLayoutMaterializeOptions {
	/**
	 * History state id to stamp — the same revision `CanvasSaveInput.revision`
	 * carries. Defaults to 0 for a caller with no history.
	 */
	readonly revision?: number;
}

/**
 * Write a resolution's geometry into the document and stamp its freshness.
 *
 * The stamp is what lets a later reader tell "this cached geometry matches the
 * current intent" from "this cached geometry is from two edits ago", which is
 * the whole reason the cache is safe to persist at all.
 *
 * Only pages present in `resolved` are rewritten; resolving a subset of pages
 * and materializing the result leaves the others untouched rather than
 * blanking them.
 */
export function materializeCanvasLayout(
	ir: CanvasIR,
	resolved: CanvasResolvedDocument,
	options: CanvasLayoutMaterializeOptions = {},
): CanvasIR {
	const written: CanvasIR = {
		...ir,
		pages: ir.pages.map((page) =>
			resolved.pageRoots.has(page.id) ? writePage(page, resolved, false) : page,
		),
	};
	const manifestHash = resolutionManifestHash(resolved);
	const stamp: CanvasLayoutMaterialization = {
		engineVersion: resolved.engineVersion,
		// Hashed over the document being WRITTEN, not the one that was resolved.
		//
		// Materialization writes resolved geometry into `pages`, and the input
		// hash covers `pages` — so stamping `resolved.inputHash` (taken before
		// the write) produces a stamp that never matches its own document, and
		// `layout-materialization-stale` fires immediately on a cache that is in
		// fact perfectly fresh. A warning that is always on is a warning nobody
		// reads, so the stamp must describe the document it is attached to.
		//
		// Staleness detection is unaffected: any later edit to intent, content
		// or free geometry changes `pages` again and the hashes diverge.
		inputHash: computeInputHash(written, manifestHash),
		resolvedAtRevision: options.revision ?? 0,
		...(manifestHash ? { measurementManifestHash: manifestHash } : {}),
	};
	return { ...written, layoutMaterialization: stamp };
}

export interface CanvasLayoutFlattenOptions extends CanvasLayoutResolveOptions {
	/**
	 * Reuse an existing resolution instead of computing a fresh one. Pass the
	 * document the editor is already showing so the flattened result is
	 * pixel-identical to what the author was looking at.
	 */
	readonly resolved?: CanvasResolvedDocument;
	/**
	 * Also drop `layout.auto.v1` from `compatibility.requiredCapabilities`.
	 * Defaults to `true`.
	 *
	 * A flattened document carries no layout intent, so continuing to declare
	 * the capability would make an older reader refuse a document it can now
	 * read perfectly well — the opposite of what flattening is for.
	 */
	readonly clearCapability?: boolean;
}

/** The capability a layout-bearing document declares. */
const LAYOUT_CAPABILITY = "layout.auto.v1";

/**
 * Replace Auto Layout intent with the absolute geometry it currently resolves
 * to.
 *
 * The result renders identically and contains no `autoLayout`, no
 * `layoutItem`, and no materialization stamp — there is nothing left to be
 * stale about. This is the rollback and export-compatibility path, and it is
 * deliberately lossy: the intent cannot be reconstructed from the geometry, so
 * a caller must write the result somewhere new (PRD §19).
 */
export function flattenCanvasLayout(
	ir: CanvasIR,
	options: CanvasLayoutFlattenOptions = {},
): CanvasIR {
	const resolved = options.resolved ?? resolveCanvasLayout(ir, options);
	const { layoutMaterialization: _stamp, ...rest } = ir;
	const flattened: CanvasIR = {
		...rest,
		pages: ir.pages.map((page) =>
			resolved.pageRoots.has(page.id) ? writePage(page, resolved, true) : page,
		),
	};

	if (options.clearCapability === false || !flattened.compatibility) {
		return flattened;
	}
	const remaining = flattened.compatibility.requiredCapabilities.filter(
		(capability) => capability !== LAYOUT_CAPABILITY,
	);
	return {
		...flattened,
		compatibility: {
			...flattened.compatibility,
			requiredCapabilities: remaining,
		},
	};
}
