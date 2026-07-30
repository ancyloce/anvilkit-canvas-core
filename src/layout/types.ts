import {
	type CanvasResolvedNodeId,
	toResolvedNodeId,
} from "../components/identity.js";
import type { CanvasResolvedComponentOrigin } from "../components/types.js";
import type { AffineMatrix } from "../geometry/affine.js";
import type { Aabb } from "../geometry/hit-test.js";
import type {
	CanvasBounds,
	CanvasIR,
	CanvasNode,
	CanvasTransform,
} from "../ir/types.js";
import type {
	CanvasTextMeasurer,
	RichTextStyleDefaults,
} from "../text-contracts.js";
import type { CanvasLayoutIssue } from "./validate.js";

/**
 * @file Resolved-tree contracts (TD §5.4) — the resolver's OUTPUT shapes.
 *
 * **This file holds resolved contracts only.** Every *persisted* layout shape
 * — `CanvasAutoLayout`, `CanvasLayoutItem`, `CanvasDocumentCompatibility`,
 * `CanvasKnownCapability`, `CanvasLayoutMaterialization` — is declared in
 * `ir/types.ts` (rank 1) instead, because `ir/validators.ts` must type the
 * shape objects it spreads and `clipboard/` (rank 2) needs the capability
 * type; neither may import this domain at rank 4 (TD §17 consequence 4).
 * Adding a persisted shape here would be a layering violation that
 * `check:layering` cannot catch, since it only inspects edge direction — so
 * the split is asserted by test instead.
 *
 * Geometry types are reused **verbatim** from `geometry/`: `AffineMatrix` (the
 * SVG `matrix(a b c d e f)` tuple) and `Aabb` (an alias of `BoundsExtent`).
 * No `CanvasTransformMatrix`/`CanvasAabb` is introduced — a parallel matrix
 * type is exactly how two coordinate conventions drift apart.
 */

// Resolved-node identity moved to `components/identity.ts` (plan 0023 M2-01):
// the virtual-id codec mints these ids and `components/` (rank 2) cannot
// import upward from `layout/` (rank 4). Re-exported here unchanged, so every
// existing consumer signature — and the public barrel — is untouched.
export {
	type CanvasResolvedNodeId,
	toResolvedNodeId,
} from "../components/identity.js";

/**
 * Where a node ended up, in every space a consumer needs.
 *
 * `localTransform` and `bounds` are what materialization writes back into the
 * document; `worldTransform`/`worldAabb` are what hit-testing, snapping,
 * marquee selection and export bounds read; `layoutFootprint` is what the
 * solver itself did arithmetic on.
 */
export interface CanvasResolvedGeometry {
	/** Local transform relative to the parent. Scale is 1 on any axis layout controls (TD §7.7). */
	readonly localTransform: CanvasTransform;
	/** Local box size. Prior scale on a layout-controlled axis is folded in here. */
	readonly bounds: CanvasBounds;
	/** `parentWorld × local`, in the same convention as `toAffineMatrix`. */
	readonly worldTransform: AffineMatrix;
	/** Axis-aligned bounding box in world space. */
	readonly worldAabb: Aabb;
	/**
	 * Axis-aligned extent of this node in its **parent's** coordinate space —
	 * the box the solver allocated space for.
	 *
	 * An `Aabb`, not a `CanvasBounds`, because `CanvasBounds` is `{width,
	 * height}` only and a rotated child's footprint carries an offset from the
	 * local origin: a 100×40 box rotated 45° starts at a negative x relative to
	 * its own transform. Placement has to add that offset back, so the origin
	 * cannot be dropped (TD §5.4, §7.7).
	 */
	readonly layoutFootprint: Aabb;
}

export interface CanvasResolvedNodeRecord {
	readonly id: CanvasResolvedNodeId;
	readonly sourceNodeId: string;
	readonly parentId?: CanvasResolvedNodeId;
	/**
	 * Resolved children in flow order.
	 *
	 * **Stored, not derived.** TD §12.1 makes `getChildren` a required consumer
	 * API called per node by the renderer and the accessibility tree; deriving
	 * it from `parentId` would turn every such call into a full scan of
	 * `records`, i.e. O(n²) over one render pass.
	 */
	readonly childIds: readonly CanvasResolvedNodeId[];
	/** The source node this record resolves. Style and content are read from here; geometry never is. */
	readonly node: CanvasNode;
	readonly geometry: CanvasResolvedGeometry;
	/**
	 * Component provenance when this record is a VIRTUAL node expanded from a
	 * component instance (plan 0023 M2-03). Absent on every record of a
	 * component-free document — additive, existing consumers untouched.
	 */
	readonly component?: CanvasResolvedComponentOrigin;
}

/**
 * One immutable resolution of one document.
 *
 * ### Incremental resolution contract (TD §5.4)
 *
 * Re-resolving must not mean rebuilding from scratch: a 1,000-node document
 * allocating 1,000 fresh records per pointer move cannot meet the ≤16 ms warm
 * target. So a resolution that dirties a subtree returns a **new**
 * `CanvasResolvedDocument` whose `records` **structurally shares** every record
 * object that did not change — untouched records are reference-identical
 * between consecutive resolutions, which is also what lets renderers memoise
 * on record identity.
 *
 * Consumers must treat record identity as a valid change signal and must not
 * deep-compare geometry.
 */
export interface CanvasResolvedDocument {
	/** The exact IR this resolution was produced from. */
	readonly source: CanvasIR;
	readonly records: ReadonlyMap<CanvasResolvedNodeId, CanvasResolvedNodeRecord>;
	/** Page id → that page's root record ids, in document order. */
	readonly pageRoots: ReadonlyMap<string, readonly CanvasResolvedNodeId[]>;
	/**
	 * Ordered per TD §14; byte-stable across repeated resolutions of one
	 * document. Bounded by `MAX_RETAINED_DIAGNOSTICS` — see
	 * {@link CanvasResolvedDocument.truncatedDiagnostics}.
	 */
	readonly diagnostics: readonly CanvasLayoutIssue[];
	/**
	 * How many diagnostics were dropped past the retention cap; `0` when the
	 * list above is complete.
	 *
	 * Diagnostics are emitted per offending node, so a systematically broken
	 * document can produce one per node — `limits.ts` caps the retained list to
	 * keep a report reviewable and its byte size bounded for hosts that persist
	 * or transmit it. This field is what stops that from being a silent lie: a
	 * caller seeing a full list and a zero here knows it has the whole story.
	 *
	 * Not in TD §5.4's published shape; added because `limits.ts` requires the
	 * dropped count be "reported alongside", and there is nowhere else to put
	 * it — the `CanvasLayoutIssueCode` union is frozen at 11 members, so a
	 * synthetic "…and N more" diagnostic is not available either.
	 *
	 * The retained entries are the **prefix in TD §14 order**, not the most
	 * severe ones: that order is normative and re-sorting by severity would
	 * make the array depend on something other than the specified key.
	 */
	readonly truncatedDiagnostics: number;
	/** Resolver engine identity — matches `CanvasLayoutMaterialization.engineVersion`. */
	readonly engineVersion: 1;
	/** Hash of the resolver inputs, for the materialization freshness stamp. */
	readonly inputHash: string;
}

/**
 * Host-supplied measurement (TD §8.1).
 *
 * Composes the existing `CanvasTextMeasurer` port; it never redefines it. That
 * port is synchronous and required to be pure, because the same measurer must
 * produce identical line breaks in the editor, in an export worker, and in
 * Node — so the resolver is synchronous too and there is **no `Promise`
 * variant**. Async font/asset work happens entirely before resolution.
 */
export interface CanvasLayoutMeasurementProvider {
	/** The existing Core port, reused verbatim. */
	readonly measureText: CanvasTextMeasurer;
	/**
	 * Only for assets whose intrinsic size is not already recorded on
	 * `ir.assets[assetId]` (`CanvasAssetRef.width`/`height`), which the resolver
	 * consults **first** — the document is authoritative over the provider,
	 * because it is what an export worker also has.
	 */
	readonly getIntrinsicAssetSize?: (
		assetId: string,
	) => CanvasBounds | undefined;
	/**
	 * Identity of the font/asset manifest in force. Part of the measurement key,
	 * so a font load that changes metrics invalidates cached measurements
	 * instead of silently reusing pre-load ones.
	 */
	readonly manifestHash?: string;
}

/**
 * Resolver options.
 *
 * PRD §9.3 writes `resolveCanvasLayout(ir, options)` with `options` required
 * while TD §5.4 makes every field optional. The parameter is therefore
 * required with all-optional fields, which satisfies both readings (plan §10.1).
 */
export interface CanvasLayoutResolveOptions {
	/** Omit for a document with no text/asset-driven Hug; missing inputs are diagnosed, not thrown. */
	readonly measurement?: CanvasLayoutMeasurementProvider;
	/** Same fallback semantics as `SvgSerializeOptions.richTextDefaults`. */
	readonly richTextDefaults?: Partial<RichTextStyleDefaults>;
	/** Restrict resolution to these pages; omit to resolve the whole document. */
	readonly pageIds?: readonly string[];
	/**
	 * A previous resolution of the same document, used as the warm-path cache
	 * seed. Omit for a cold resolve.
	 *
	 * Passing it is what makes untouched records reference-identical across
	 * resolutions; the resolver validates it against the current IR rather than
	 * trusting it, so a stale or foreign document degrades to a cold pass
	 * instead of producing wrong geometry.
	 */
	readonly previous?: CanvasResolvedDocument;
}

/**
 * The read adapter consumers use instead of touching `records` directly
 * (TD §12.1).
 *
 * Kept as an interface rather than a class so a host can wrap or decorate it,
 * and so PRD 0015's virtual nodes can be served through the same three methods.
 */
export interface CanvasResolvedView {
	getRecord(
		id: CanvasResolvedNodeId | string,
	): CanvasResolvedNodeRecord | undefined;
	getChildren(
		id: CanvasResolvedNodeId | string,
	): readonly CanvasResolvedNodeRecord[];
	getPageRoots(pageId: string): readonly CanvasResolvedNodeRecord[];
}

/** Wrap a resolved document in the {@link CanvasResolvedView} read adapter. */
export function createResolvedView(
	document: CanvasResolvedDocument,
): CanvasResolvedView {
	const getRecord = (id: CanvasResolvedNodeId | string) =>
		document.records.get(toResolvedNodeId(id));
	return {
		getRecord,
		getChildren: (id) => {
			const record = getRecord(id);
			if (!record) return [];
			const children: CanvasResolvedNodeRecord[] = [];
			for (const childId of record.childIds) {
				const child = document.records.get(childId);
				if (child) children.push(child);
			}
			return children;
		},
		getPageRoots: (pageId) => {
			const roots: CanvasResolvedNodeRecord[] = [];
			for (const id of document.pageRoots.get(pageId) ?? []) {
				const record = document.records.get(id);
				if (record) roots.push(record);
			}
			return roots;
		},
	};
}
