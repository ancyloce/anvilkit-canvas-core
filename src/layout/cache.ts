import { fingerprint64 } from "../hash.js";
import type {
	CanvasAssetRef,
	CanvasNode,
	CanvasRichTextNode,
	CanvasTextNode,
} from "../ir/types.js";
import type {
	CanvasResolvedGeometry,
	CanvasResolvedNodeRecord,
} from "./types.js";

/**
 * @file Runtime signatures and structural sharing (TD §9, T-M2-07).
 *
 * ### Why signatures, and why a `WeakMap`
 *
 * Re-resolving must not mean rebuilding from scratch: a 1,000-node document
 * allocating 1,000 fresh records on every pointer move cannot meet the ≤16 ms
 * warm target, and the ≤50 ms cold target is a separate measurement precisely
 * because the warm one assumes this layer exists.
 *
 * The fast path falls out of an existing property of the command layer rather
 * than from hashing: `applyCommand` builds each new `CanvasIR` by structurally
 * sharing every subtree it did not touch, so an unedited node is the **same
 * object** across revisions. Keying the signature cache on the node object
 * therefore makes an unedited subtree a `WeakMap` lookup — no traversal, no
 * hashing — and gives free eviction when a revision is dropped. It is the same
 * trick the editor's text cache uses on the `paragraphs` array reference, and
 * for the same reason: a content hash computed per frame is exactly the
 * per-frame cost this is meant to avoid.
 *
 * ### What a signature covers, and what it must not
 *
 * Only inputs that can move geometry. `opacity`, `locked`, `name`, `meta`,
 * fills, strokes and radii are excluded — changing them must not invalidate a
 * layout — and so is `visible`, because hidden children participate in flow
 * exactly like visible ones (§7.2), which means toggling an eye icon is
 * genuinely a no-op for the resolver rather than merely a cheap one.
 */

/** Private per-resolution cache state. Never exported through `layout/index.ts`. */
export interface LayoutCacheState {
	/** Signature per node object — the reference fast path. */
	readonly signatures: WeakMap<object, string>;
	/** The asset map the signatures were computed against. */
	readonly assets: Readonly<Record<string, CanvasAssetRef>>;
	/** Measurement manifest identity at the time of computation. */
	readonly manifestHash: string;
	/**
	 * Subtrees placed by the PREVIOUS resolution, keyed by node id plus the
	 * allocation and depth they were placed under. Typed `unknown` because the
	 * placed-node shape is private to the solver and must not leak into a
	 * module the barrel could reach.
	 */
	readonly placed: ReadonlyMap<string, unknown>;
	/** Records from the previous resolution, for reference-identity reuse. */
	readonly records: ReadonlyMap<string, CanvasResolvedNodeRecord>;
}

export function createCacheState(
	assets: Readonly<Record<string, CanvasAssetRef>>,
	manifestHash: string,
	previous?: LayoutCacheState,
): LayoutCacheState {
	// Signatures survive only while the inputs they were computed against do.
	// A new asset map can change an image's intrinsic size, and a new
	// measurement manifest can change a glyph's; either invalidates every
	// signature, so the WeakMap is rebuilt rather than selectively purged. The
	// placed/record caches go with them — reusing a placement computed against
	// different intrinsic sizes is exactly the stale-cache bug this layer
	// exists to avoid.
	const reusable =
		previous !== undefined &&
		previous.assets === assets &&
		previous.manifestHash === manifestHash;
	return {
		signatures: reusable ? previous.signatures : new WeakMap<object, string>(),
		assets,
		manifestHash,
		placed: reusable ? previous.placed : new Map(),
		records: reusable ? previous.records : new Map(),
	};
}

/** Carry this resolution's results forward as the next one's warm state. */
export function advanceCacheState(
	current: LayoutCacheState,
	placed: ReadonlyMap<string, unknown>,
	records: ReadonlyMap<string, CanvasResolvedNodeRecord>,
): LayoutCacheState {
	return { ...current, placed, records };
}

/** Field separator that cannot appear in an id, a font name, or a number. */
const SEP = "";

function transformParts(node: CanvasNode): string {
	const t = node.transform;
	return [
		t.x,
		t.y,
		t.rotation,
		t.scaleX,
		t.scaleY,
		t.skewX ?? 0,
		t.skewY ?? 0,
	].join(",");
}

/** Inputs that decide a leaf's intrinsic size, per kind. */
function intrinsicParts(
	node: CanvasNode,
	assets: Readonly<Record<string, CanvasAssetRef>>,
): string {
	if (node.type === "text") {
		const text = node as CanvasTextNode;
		return [
			text.text,
			typeof text.fontFamily === "string"
				? text.fontFamily
				: JSON.stringify(text.fontFamily),
			text.fontSize,
			text.fontWeight ?? "",
			text.align ?? "",
		].join(",");
	}
	if (node.type === "rich-text") {
		const rich = node as CanvasRichTextNode;
		return [
			JSON.stringify(rich.paragraphs),
			rich.sizing ?? "",
			rich.width,
			rich.height ?? "",
			rich.wrap ?? "",
			// `overflow` is in the signature but NOT in the measurement key: it
			// cannot change how a block is measured, but `auto-height` does decide
			// whether this node hugs its block axis at all (§7.2).
			rich.overflow ?? "",
		].join(",");
	}
	if (
		node.type === "image" ||
		node.type === "svg" ||
		node.type === "video" ||
		node.type === "audio"
	) {
		const asset = assets[node.assetId];
		return `${node.assetId},${asset?.width ?? ""},${asset?.height ?? ""}`;
	}
	return "";
}

/**
 * Signature of a node and everything below it.
 *
 * Recursive over `children` in order, so a reorder changes the parent's
 * signature even when no child's own signature moved — child *order* is a
 * layout input.
 */
export function subtreeSignature(
	node: CanvasNode,
	state: LayoutCacheState,
): string {
	const cached = state.signatures.get(node);
	if (cached !== undefined) return cached;

	const parts: string[] = [
		node.type,
		node.id,
		transformParts(node),
		`${node.bounds.width},${node.bounds.height}`,
		node.layoutItem
			? `${node.layoutItem.positioning ?? ""},${node.layoutItem.widthSizing ?? ""},${node.layoutItem.heightSizing ?? ""}`
			: "",
		node.type === "frame" && node.autoLayout
			? [
					node.autoLayout.version,
					node.autoLayout.direction,
					node.autoLayout.padding.top,
					node.autoLayout.padding.right,
					node.autoLayout.padding.bottom,
					node.autoLayout.padding.left,
					node.autoLayout.gap,
					node.autoLayout.primaryAlign,
					node.autoLayout.crossAlign,
				].join(",")
			: "",
		// A frame rendering its placeholder cannot Hug (§7.2), so placeholder
		// presence is a sizing input even though it is otherwise paint.
		node.type === "frame" && node.placeholder ? "placeholder" : "",
		intrinsicParts(node, state.assets),
	];
	for (const child of (node as { children?: readonly CanvasNode[] }).children ??
		[]) {
		parts.push(subtreeSignature(child, state));
	}

	const signature = fingerprint64(parts.join(SEP));
	state.signatures.set(node, signature);
	return signature;
}

function sameGeometry(
	a: CanvasResolvedGeometry,
	b: CanvasResolvedGeometry,
): boolean {
	if (
		a.bounds.width !== b.bounds.width ||
		a.bounds.height !== b.bounds.height
	) {
		return false;
	}
	const at = a.localTransform;
	const bt = b.localTransform;
	if (
		at.x !== bt.x ||
		at.y !== bt.y ||
		at.rotation !== bt.rotation ||
		at.scaleX !== bt.scaleX ||
		at.scaleY !== bt.scaleY ||
		(at.skewX ?? 0) !== (bt.skewX ?? 0) ||
		(at.skewY ?? 0) !== (bt.skewY ?? 0)
	) {
		return false;
	}
	for (let i = 0; i < 6; i++) {
		if (a.worldTransform[i] !== b.worldTransform[i]) return false;
	}
	// `worldAabb` and `layoutFootprint` are pure functions of the two above, so
	// comparing them as well would be redundant work on the hot path.
	return true;
}

/**
 * Reuse the previous record object when nothing observable about it changed.
 *
 * This is what makes TD §5.4's incremental contract true: untouched records are
 * reference-identical between consecutive resolutions, so a renderer can
 * memoise on record identity and must never deep-compare geometry. The source
 * node is compared by **identity**, not by value — a node object that was
 * rebuilt is a node whose style or content may have changed, and the record
 * carries that node onward to consumers that read style from it.
 */
export function reuseRecord(
	candidate: CanvasResolvedNodeRecord,
	previous: CanvasResolvedNodeRecord | undefined,
): CanvasResolvedNodeRecord {
	if (!previous) return candidate;
	if (previous.node !== candidate.node) return candidate;
	if (previous.parentId !== candidate.parentId) return candidate;
	if (previous.childIds.length !== candidate.childIds.length) return candidate;
	for (let i = 0; i < previous.childIds.length; i++) {
		if (previous.childIds[i] !== candidate.childIds[i]) return candidate;
	}
	return sameGeometry(previous.geometry, candidate.geometry)
		? previous
		: candidate;
}
