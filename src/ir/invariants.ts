import { resolveFrameClipShape } from "./frame-clip.js";
import type { CanvasIR, CanvasNode, CanvasPage } from "./types.js";
import {
	type CanvasDocumentLocation,
	CanvasIRDepthError,
	walkDocument,
	walkPage,
} from "./walkers.js";

/**
 * Semantic invariant validation (P0-6) — deliberately separate from
 * `ir/validators.ts`'s Zod schemas. A schema checks SHAPE (is `id` a
 * non-empty string, is `pages` an array with >= 1 element); it cannot express
 * whole-document facts like "every node id is unique" or "every `assetId` a
 * node references exists in `ir.assets`" — those require walking the tree and
 * cross-referencing, which is exactly what this module does.
 *
 * This is NOT wired into `applyCommand`/`applyCommands`/`migrateCanvasIR` by
 * default: those stay O(1)-per-field (schema) or O(single-node) (a command),
 * not O(document) on every call. Call `validateCanvasIRInvariants` explicitly
 * at a trust boundary instead — decoding a persisted/remote document, a CI
 * fixture check, or a host's own post-batch assertion — where an O(document)
 * pass is proportionate to the cost already being paid there.
 */

export type CanvasInvariantIssueCode =
	| "duplicate-page-id"
	| "duplicate-node-id"
	| "invalid-page-root"
	| "asset-key-id-mismatch"
	| "dangling-asset-reference"
	| "excessive-tree-depth"
	| "missing-required-capability"
	| "unsupported-frame-clip-shape";

/**
 * The capability string a document must declare once any of its content
 * carries Auto Layout intent.
 *
 * A runtime constant rather than a bare literal at each call site, but note it
 * is deliberately NOT the type of any schema field: `requiredCapabilities` is
 * an open `string[]`, so an unknown capability parses and degrades gracefully
 * instead of failing validation (see `CanvasDocumentCompatibility`).
 */
export const CANVAS_LAYOUT_AUTO_CAPABILITY = "layout.auto.v1";

/** Capability ids for document-local components (plan 0023, LC-COMPAT-001). */
export const CANVAS_COMPONENTS_LOCAL_CAPABILITY = "components.local.v1";
export const CANVAS_COMPONENTS_OVERRIDES_CAPABILITY = "components.overrides.v1";

export interface CanvasInvariantIssue {
	readonly code: CanvasInvariantIssueCode;
	readonly message: string;
	/** The page the issue was found on, when the issue is page-scoped. */
	readonly pageId?: string;
	/** The node the issue was found on, when the issue is node-scoped. */
	readonly nodeId?: string;
	/**
	 * Where the offending node lives when a Component Source tree is involved
	 * (plan 0023 TD-001). Absent for purely page-scoped issues, whose
	 * `pageId` already says everything.
	 */
	readonly location?: CanvasDocumentLocation;
}

/** Asset ids a single node references, by kind. Never includes `assetToken` — that resolves against an external brand kit, not `ir.assets`. */
function assetIdsReferencedByNode(node: CanvasNode): readonly string[] {
	switch (node.type) {
		case "image":
			// `maskAssetId` is deprecated (ADR 0008 decision 3, removal at
			// `@anvilkit/canvas-core@1.0.0`) but is deliberately STILL READ here: a
			// deprecated reference is still a reference. Drop it before the field
			// itself goes and this invariant starts reporting a false
			// `dangling-asset-reference` — or worse, a host GC treats a live asset
			// as collectable. `clipboard/payload.ts` mirrors this enumeration, so
			// the two move together or not at all.
			return node.maskAssetId
				? [node.assetId, node.maskAssetId]
				: [node.assetId];
		case "svg":
			return [node.assetId];
		case "video":
			return node.poster ? [node.assetId, node.poster] : [node.assetId];
		case "audio":
			return [node.assetId];
		case "frame":
			return node.placeholder?.assetId ? [node.placeholder.assetId] : [];
		case "component-instance": {
			// Image OVERRIDES reference assets exactly like image nodes do — an
			// asset referenced only from an override map must not be reported
			// dangling-in-reverse (garbage-collectable) by any consumer of this
			// collection (plan 0023 M1-08, T-DOC-4).
			const ids: string[] = [];
			for (const override of Object.values(node.overrides ?? {})) {
				if (override.kind === "image") ids.push(override.assetId);
			}
			return ids;
		}
		default:
			return [];
	}
}

/**
 * Does this node carry layout intent that a reader must understand
 * `layout.auto.v1` to honour?
 *
 * A `layoutItem` whose every field is absent or at its default (`flow` /
 * `fixed`) is semantically identical to no `layoutItem` at all, so it does
 * NOT make the capability required — otherwise a normalizer that writes an
 * empty record would silently make a plain document layout-bearing.
 *
 * Exported (T-M3-02) so the SVG serializer's `LAYOUT_UNRESOLVED` detection
 * shares this exact predicate — a second copy would let "capability required"
 * and "resolution required" drift apart, and they are the same question.
 */
export function nodeCarriesLayoutIntent(node: CanvasNode): boolean {
	if (node.type === "frame" && node.autoLayout !== undefined) return true;
	const item = node.layoutItem;
	if (!item) return false;
	return (
		(item.positioning !== undefined && item.positioning !== "flow") ||
		(item.widthSizing !== undefined && item.widthSizing !== "fixed") ||
		(item.heightSizing !== undefined && item.heightSizing !== "fixed")
	);
}

/**
 * Does any node on this page carry layout intent (see
 * {@link nodeCarriesLayoutIntent})? One `walkPage` pass; used by consumers
 * that need to know whether stored geometry alone can be trusted for a page —
 * e.g. the SVG serializer deciding whether to warn `LAYOUT_UNRESOLVED`.
 */
export function pageCarriesLayoutIntent(page: CanvasPage): boolean {
	let found = false;
	walkPage(page, ({ node }) => {
		if (!found && nodeCarriesLayoutIntent(node)) found = true;
	});
	return found;
}

/**
 * Validate document-wide semantic invariants a Zod schema cannot express.
 * Pure and read-only; never throws for a malformed-but-schema-valid `CanvasIR`
 * — malformations are reported as issues, not exceptions (use
 * {@link assertCanvasIRInvariants} for a throwing variant). Runs one `walk`
 * over the whole document (O(n) in total node count) plus O(pages) and
 * O(assets) passes.
 */
export function validateCanvasIRInvariants(
	ir: CanvasIR,
): CanvasInvariantIssue[] {
	const issues: CanvasInvariantIssue[] = [];

	const pageIdCounts = new Map<string, number>();
	for (const page of ir.pages) {
		pageIdCounts.set(page.id, (pageIdCounts.get(page.id) ?? 0) + 1);
	}
	for (const [id, count] of pageIdCounts) {
		if (count > 1) {
			issues.push({
				code: "duplicate-page-id",
				message: `Page id "${id}" is used by ${count} pages — page ids must be unique.`,
				pageId: id,
			});
		}
	}

	for (const page of ir.pages) {
		if (page.root.type !== "group") {
			issues.push({
				code: "invalid-page-root",
				message: `Page "${page.id}"'s root must be a "group" node (found "${(page.root as CanvasNode).type}").`,
				pageId: page.id,
			});
		}
	}

	// One walk covers whole-document node-id uniqueness — `findNode`/
	// `parentOf` return the FIRST match across pages, so a duplicate id
	// anywhere makes every walker silently resolve to the wrong node — plus
	// asset-reference collection. `walkDocument` (plan 0023 M1-08) extends
	// the pass over Component Source trees, which is what makes INV-2 ("node
	// ids unique across Pages AND definitions") enforceable at all.
	const nodeIdLocations = new Map<string, CanvasDocumentLocation[]>();
	const referencedAssetIds = new Set<string>();
	// Capability completeness rides along on the SAME walk rather than adding a
	// second O(document) pass. `walkDocument` is pre-order (pages in document
	// order, then definitions in sorted component-id order), so
	// `firstLayoutNode` is a deterministic, document-derived exemplar.
	let layoutIntentCount = 0;
	let firstLayoutNode:
		| { nodeId: string; location: CanvasDocumentLocation }
		| undefined;
	try {
		walkDocument(ir, ({ node, location }) => {
			const seen = nodeIdLocations.get(node.id);
			if (seen) seen.push(location);
			else nodeIdLocations.set(node.id, [location]);
			for (const assetId of assetIdsReferencedByNode(node)) {
				referencedAssetIds.add(assetId);
			}
			if (nodeCarriesLayoutIntent(node)) {
				layoutIntentCount += 1;
				firstLayoutNode ??= { nodeId: node.id, location };
			}
			// A clip shape this build cannot honour (ADR 0008 decision 2). The
			// SAME resolver every renderer uses decides this — a second opinion
			// here is exactly how "what the checker calls broken" and "what the
			// canvas actually draws" drift apart. Reported per node rather than
			// once per document because each offender is a separate authoring
			// mistake, and reported regardless of `clip`: an unhonourable shape
			// on an unclipped frame is still a shape nothing can ever render, it
			// is simply not visible yet.
			if (node.type === "frame") {
				const { degradation } = resolveFrameClipShape(node);
				if (degradation !== undefined) {
					issues.push({
						code: "unsupported-frame-clip-shape",
						message: `Frame "${node.id}" declares a clip shape this build cannot honour (kind "${String(node.shape?.kind)}": ${degradation}) — it degrades to the frame's rectangle.`,
						nodeId: node.id,
						...(location.kind === "page"
							? { pageId: location.id }
							: { location }),
					});
				}
			}
		});
	} catch (err) {
		if (err instanceof CanvasIRDepthError) {
			issues.push({ code: "excessive-tree-depth", message: err.message });
		} else {
			throw err;
		}
	}
	for (const [id, locations] of nodeIdLocations) {
		if (locations.length > 1) {
			const componentLocation = locations.find((l) => l.kind === "component");
			// Page-only duplicates keep the pre-M1-08 message byte-for-byte;
			// the INV-2 wording (and the `location` field) appears only when a
			// Source tree is involved.
			issues.push({
				code: "duplicate-node-id",
				message: componentLocation
					? `Node id "${id}" appears ${locations.length} times (${locations.map((l) => `${l.kind} ${l.id}`).join(", ")}) — node ids must be unique across pages AND component definitions (INV-2).`
					: `Node id "${id}" appears ${locations.length} times (page(s): ${locations.map((l) => l.id).join(", ")}) — node ids must be unique across the whole document.`,
				nodeId: id,
				...(componentLocation ? { location: componentLocation } : {}),
			});
		}
	}

	for (const [key, asset] of Object.entries(ir.assets)) {
		if (asset.id !== key) {
			issues.push({
				code: "asset-key-id-mismatch",
				message: `ir.assets["${key}"].id is "${asset.id}" — the record key and the asset's own id must match.`,
			});
		}
	}
	for (const assetId of referencedAssetIds) {
		if (!(assetId in ir.assets)) {
			issues.push({
				code: "dangling-asset-reference",
				message: `Asset id "${assetId}" is referenced by a node but is not present in ir.assets.`,
			});
		}
	}

	// Capability COMPLETENESS (TD §5.1, level 2): content that needs
	// `layout.auto.v1` must say so. Without this, a layout-bearing document
	// written by a partial writer — or hand-edited, or round-tripped through a
	// clipboard — parses cleanly and is then edited destructively by every
	// reader, which is the exact data-loss the capability mechanism exists to
	// prevent.
	//
	// One issue per document, not per node: whether the declaration is present
	// is a single document-level fact, and emitting it per offender would turn
	// a one-line omission into O(nodes) of noise. The exemplar node is the
	// pre-order-first one, so the output stays deterministic.
	if (
		firstLayoutNode &&
		!ir.compatibility?.requiredCapabilities.includes(
			CANVAS_LAYOUT_AUTO_CAPABILITY,
		)
	) {
		issues.push({
			code: "missing-required-capability",
			message: `Document carries Auto Layout intent on ${layoutIntentCount} node(s) (first: "${firstLayoutNode.nodeId}") but does not declare "${CANVAS_LAYOUT_AUTO_CAPABILITY}" in compatibility.requiredCapabilities.`,
			// A page exemplar keeps the pre-M1-08 `pageId` shape; intent found
			// only inside a Source tree carries its component `location`
			// instead — layout intent in a definition makes the capability
			// required exactly like intent on a page (it WILL be expanded).
			...(firstLayoutNode.location.kind === "page"
				? { pageId: firstLayoutNode.location.id }
				: { location: firstLayoutNode.location }),
			nodeId: firstLayoutNode.nodeId,
		});
	}

	return issues;
}

/** Thrown by {@link assertCanvasIRInvariants}; carries every issue found, not just the first. */
export class CanvasIRInvariantError extends Error {
	readonly issues: readonly CanvasInvariantIssue[];

	constructor(issues: readonly CanvasInvariantIssue[]) {
		super(
			`CanvasIR failed ${issues.length} semantic invariant check(s): ${issues
				.map((i) => i.message)
				.join(" | ")}`,
		);
		this.name = "CanvasIRInvariantError";
		this.issues = issues;
	}
}

/** Throwing wrapper around {@link validateCanvasIRInvariants} for a hard trust-boundary check. */
export function assertCanvasIRInvariants(ir: CanvasIR): void {
	const issues = validateCanvasIRInvariants(ir);
	if (issues.length > 0) {
		throw new CanvasIRInvariantError(issues);
	}
}
