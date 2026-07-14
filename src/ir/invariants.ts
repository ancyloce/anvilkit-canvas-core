import type { CanvasIR, CanvasNode } from "./types.js";
import { CanvasIRDepthError, walk } from "./walkers.js";

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
	| "excessive-tree-depth";

export interface CanvasInvariantIssue {
	readonly code: CanvasInvariantIssueCode;
	readonly message: string;
	/** The page the issue was found on, when the issue is page-scoped. */
	readonly pageId?: string;
	/** The node the issue was found on, when the issue is node-scoped. */
	readonly nodeId?: string;
}

/** Asset ids a single node references, by kind. Never includes `assetToken` — that resolves against an external brand kit, not `ir.assets`. */
function assetIdsReferencedByNode(node: CanvasNode): readonly string[] {
	switch (node.type) {
		case "image":
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
		default:
			return [];
	}
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

	// One walk covers both whole-document node-id uniqueness — `findNode`/
	// `parentOf` return the FIRST match across pages, so a duplicate id
	// anywhere makes every walker silently resolve to the wrong node — and
	// asset-reference collection.
	const nodeIdPages = new Map<string, string[]>();
	const referencedAssetIds = new Set<string>();
	try {
		walk(ir, ({ node, page }) => {
			const pages = nodeIdPages.get(node.id);
			if (pages) pages.push(page.id);
			else nodeIdPages.set(node.id, [page.id]);
			for (const assetId of assetIdsReferencedByNode(node)) {
				referencedAssetIds.add(assetId);
			}
		});
	} catch (err) {
		if (err instanceof CanvasIRDepthError) {
			issues.push({ code: "excessive-tree-depth", message: err.message });
		} else {
			throw err;
		}
	}
	for (const [id, pages] of nodeIdPages) {
		if (pages.length > 1) {
			issues.push({
				code: "duplicate-node-id",
				message: `Node id "${id}" appears ${pages.length} times (page(s): ${pages.join(", ")}) — node ids must be unique across the whole document.`,
				nodeId: id,
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
