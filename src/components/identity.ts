/**
 * @file Identity rules for Local Components (plan 0023 M1-10, TD §5.5).
 *
 * The frozen rules, in one place:
 *
 * - **Component ids** are globally unique within a document — the Registry
 *   key equals `definition.id` (INV-1, schema-enforced).
 * - **Source node ids** are unique across Pages AND all definitions (INV-2,
 *   enforced by `validateCanvasIRInvariants` via `walkDocument`).
 * - **Property ids** are unique per definition. The SAME id on two different
 *   definitions is explicitly PERMITTED (TD §5.5) and must never be rejected:
 *   overrides resolve against ONE instance's ONE definition, so the pair
 *   (componentId, propertyId) is always unambiguous — see
 *   {@link findComponentProperty}.
 * - **Remapping**: `regenerateNodeIds` is the only id-remap primitive and
 *   rewrites `node.id` alone — never `componentId`, never override-map keys,
 *   never id-shaped string values (INV-9, pinned by its own suite).
 *
 * Ids come from INJECTED factories only — no call site generates its own
 * format — so hosts and tests control determinism the same way
 * `regenerateNodeIds`' `idFactory` option does.
 */

import type {
	CanvasComponentDefinition,
	CanvasComponentProperty,
} from "../ir/types.js";

/**
 * Identity of a node in the resolved tree.
 *
 * Branded rather than a bare `string` so a source node id and a resolved node
 * id cannot be swapped at a call site. For plain nodes the two are 1:1; a
 * virtual component node's id encodes its expansion path via the codec below.
 * Declared HERE (rank 2) rather than in `layout/types.ts` (rank 4, which
 * re-exports it unchanged) because the codec mints these ids and rank 2
 * cannot import upward (plan 0023 M2-01).
 */
export type CanvasResolvedNodeId = string & {
	readonly __brand: "CanvasResolvedNodeId";
};

/**
 * Brand a source node id as a resolved id.
 *
 * The only sanctioned way to produce a `CanvasResolvedNodeId` for a
 * NON-virtual node, so the source→resolved mapping stays one function rather
 * than a cast at every construction site. Virtual nodes use
 * {@link encodeResolvedNodeId}.
 */
export function toResolvedNodeId(sourceNodeId: string): CanvasResolvedNodeId {
	return sourceNodeId as CanvasResolvedNodeId;
}

/**
 * The conceptual identity path of a virtual node (TD §9.2):
 * `[outerInstanceId, sourceNodeId, nestedInstanceId, nestedSourceNodeId, …]`.
 * A plain node's path is the single-segment `[sourceNodeId]`.
 */
export interface CanvasVirtualNodePath {
	segments: readonly string[];
}

/**
 * Prefix marking an id produced by {@link encodeResolvedNodeId}. Version-
 * tagged so a future codec change can coexist with persisted ids in caches.
 */
const VIRTUAL_ID_PREFIX = "akv1:";

/**
 * Encode an identity path as an opaque resolved id.
 *
 * Length-prefixed — `akv1:<len>:<segment><len>:<segment>…` — NEVER naive
 * delimiter concatenation: document node ids are arbitrary strings, so any
 * unescaped delimiter scheme collides. Lengths count UTF-16 code units,
 * which is byte-stable across every JS runtime.
 *
 * Guarantee: distinct valid paths encode to distinct ids, and
 * `decodeResolvedNodeId(encodeResolvedNodeId(p))` returns `p` exactly. A
 * HOSTILE source node id that happens to equal some encoded output is a
 * document-level duplicate-identity problem (the resolver diagnoses record
 * collisions), not a codec collision — the codec never produces two ids
 * from one path or one id from two paths.
 */
export function encodeResolvedNodeId(
	path: CanvasVirtualNodePath,
): CanvasResolvedNodeId {
	if (path.segments.length === 0) {
		throw new TypeError(
			"encodeResolvedNodeId: a virtual node path needs at least one segment.",
		);
	}
	let encoded = VIRTUAL_ID_PREFIX;
	for (const segment of path.segments) {
		encoded += `${segment.length}:${segment}`;
	}
	return encoded as CanvasResolvedNodeId;
}

/**
 * Decode a resolved id back to its identity path.
 *
 * A non-virtual id (no codec prefix, or a malformed payload — e.g. a hostile
 * document node id that merely STARTS with the prefix) decodes to its
 * single-segment conceptual path rather than throwing: consumers treat ids
 * as opaque, and "this id is not a codec product" is an answer, not an error.
 */
export function decodeResolvedNodeId(
	id: CanvasResolvedNodeId,
): CanvasVirtualNodePath {
	const raw = id as string;
	if (!raw.startsWith(VIRTUAL_ID_PREFIX)) return { segments: [raw] };
	const payload = raw.slice(VIRTUAL_ID_PREFIX.length);
	const segments: string[] = [];
	let cursor = 0;
	while (cursor < payload.length) {
		const colon = payload.indexOf(":", cursor);
		if (colon <= cursor) return { segments: [raw] };
		const lengthText = payload.slice(cursor, colon);
		if (!/^\d+$/.test(lengthText)) return { segments: [raw] };
		const length = Number(lengthText);
		const start = colon + 1;
		const end = start + length;
		if (end > payload.length) return { segments: [raw] };
		segments.push(payload.slice(start, end));
		cursor = end;
	}
	if (segments.length === 0) return { segments: [raw] };
	return { segments };
}

export interface CanvasComponentIdFactories {
	/** Ids for new component definitions. */
	componentId: () => string;
	/** Ids for newly exposed properties. */
	propertyId: () => string;
	/** Ids for nodes materialized into a Source tree. */
	sourceNodeId: () => string;
}

function defaultIdFactory(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build the factory set every component-creating operation (M3) receives.
 * Pass `base` for deterministic ids in tests and replays.
 */
export function createComponentIdFactories(
	base: () => string = defaultIdFactory,
): CanvasComponentIdFactories {
	return { componentId: base, propertyId: base, sourceNodeId: base };
}

/**
 * Resolve a property id WITHIN one definition — the only lookup scope that
 * exists. There is deliberately no cross-definition index to consult, which
 * is what makes cross-definition Property-ID reuse safe.
 */
export function findComponentProperty(
	definition: CanvasComponentDefinition,
	propertyId: string,
): CanvasComponentProperty | undefined {
	return definition.properties.find((p) => p.id === propertyId);
}
