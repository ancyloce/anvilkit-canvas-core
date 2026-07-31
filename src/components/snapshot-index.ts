/**
 * @file Runtime lookup index over the external snapshot registry
 * (plan 0021 T-015, TD 0016 §5.3).
 *
 * ## Why this is in `components/` and not `component-libraries/`
 *
 * The plan places it at `component-libraries/snapshot-index.ts`, but that
 * domain is rank 4 and the resolver that consumes it (`components/resolve.ts`,
 * T-016) is rank 2 — rank 2 cannot import upward, so the index would be
 * unreachable from its only caller. It lives here instead, in the same domain
 * as the resolver, which is also what `components/types.ts` anticipates when it
 * says resolver-side contracts belong to this domain. The public
 * `@anvilkit/canvas-core/component-libraries` subpath re-exports it, so the
 * intended surface is unchanged.
 *
 * ## Why an index at all
 *
 * The persisted registry is a plain object keyed by
 * `libraryId/componentId/version/integrity`. Reading it directly means every
 * call site re-derives a key and indexes a raw record — and a raw record lookup
 * inherits `Object.prototype`, so `registry["constructor"]` returns a function
 * rather than `undefined`. This module is the one place that is handled.
 *
 * ## Discardable, never authoritative
 *
 * Purely derived and session-scoped, like `components/cache.ts`: it holds no
 * document state, never mutates the IR it reads, and dropping it costs only a
 * rebuild. The IR remains the single source of truth.
 */

import { isSnapshotKey, snapshotKey } from "../ir/snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
	CanvasExternalComponentSnapshotRegistry,
} from "../ir/types.js";

/**
 * O(1) lookup of an admitted snapshot by exact reference.
 *
 * Deliberately read-only: there is no `set`. Snapshots enter a document through
 * a command (T-021), never through this index — an index that could write would
 * be a second, unversioned way to mutate the registry.
 */
export interface CanvasExternalSnapshotIndex {
	/** The snapshot for this exact ref, or `undefined`. */
	get(
		ref: CanvasExternalComponentRef,
	): CanvasExternalComponentSnapshot | undefined;
	/** The snapshot stored under an already-derived key, or `undefined`. */
	getByKey(key: string): CanvasExternalComponentSnapshot | undefined;
	has(ref: CanvasExternalComponentRef): boolean;
	/**
	 * Whether this key names a snapshot that is PRESENT in the document but was
	 * quarantined at load (plan 0021 T-045).
	 *
	 * A quarantined snapshot is invisible to {@link get}/{@link has}, so a
	 * resolver that never asks this question degrades safely — it simply cannot
	 * resolve the Source. Asking lets a caller tell "the bytes are wrong" apart
	 * from "we never had it", which is the difference between offering re-fetch
	 * and offering removal.
	 */
	isQuarantined(key: string): boolean;
	/** Number of indexed snapshots. Excludes quarantined entries. */
	readonly size: number;
	/** Indexed keys, sorted — deterministic iteration for diagnostics. */
	keys(): readonly string[];
}

const EMPTY_INDEX: CanvasExternalSnapshotIndex = {
	isQuarantined: () => false,
	get: () => undefined,
	getByKey: () => undefined,
	has: () => false,
	size: 0,
	keys: () => [],
};

/**
 * Build a lookup index over `ir.externalComponentSnapshots`.
 *
 * Backed by a `Map`, not a null-prototype object literal. Both avoid the
 * prototype fall-through, but a `Map` cannot be defeated by a key that happens
 * to be `__proto__` (assigning that on a plain object — even one created with
 * `Object.create(null)` — is fine, but the same string reaching an
 * object-literal path elsewhere is not), and it gives `size`/iteration without
 * a second helper.
 *
 * Rebuild when the document's registry identity changes; callers that resolve
 * repeatedly against one document should build once and reuse
 * (see `components/resolve.ts`).
 */
export interface BuildExternalSnapshotIndexOptions {
	/**
	 * Keys that are in the registry but must NOT resolve (plan 0021 T-045).
	 *
	 * The load pipeline populates this after re-verification: a snapshot whose
	 * stored bytes no longer hash to its `integrity` is quarantined rather than
	 * deleted. Deleting would silently discard the user's document content and
	 * make the damage unrecoverable; quarantining keeps the exact ref in the
	 * document so the Libraries panel can re-fetch precisely that version.
	 */
	readonly quarantinedKeys?: Iterable<string>;
}

export function buildExternalSnapshotIndex(
	registry: CanvasExternalComponentSnapshotRegistry | undefined,
	options: BuildExternalSnapshotIndexOptions = {},
): CanvasExternalSnapshotIndex {
	const quarantined = new Set(options.quarantinedKeys ?? []);
	if (!registry) {
		return quarantined.size === 0
			? EMPTY_INDEX
			: { ...EMPTY_INDEX, isQuarantined: (key) => quarantined.has(key) };
	}

	// Two filters, both load-bearing (plan 0021 T-048):
	//
	// `Object.entries` gives own enumerable properties only, so an INHERITED
	// property cannot become an indexed snapshot.
	//
	// `isSnapshotKey` then rejects any key that is not a well-formed
	// `libraryId/componentId/version/integrity`. Without it a hostile or
	// hand-edited registry can file content under `__proto__`, `constructor` or
	// any other junk key: nothing is *polluted* (the index is a `Map`), but the
	// entry is retrievable through `getByKey` and inflates `size`, which is a
	// lookup answering for content no ref can legitimately address.
	const entries = Object.entries(registry).filter(
		([key]) => isSnapshotKey(key) && !quarantined.has(key),
	);
	if (entries.length === 0 && quarantined.size === 0) return EMPTY_INDEX;

	const byKey = new Map<string, CanvasExternalComponentSnapshot>(entries);

	return {
		isQuarantined: (key) => quarantined.has(key),
		get(ref) {
			// A ref that cannot be keyed is a miss, not a throw: this runs on the
			// render path, where an unresolvable Source degrades to a placeholder
			// rather than taking the document down (INV-3).
			let key: string;
			try {
				key = snapshotKey(ref);
			} catch {
				return undefined;
			}
			return byKey.get(key);
		},
		getByKey(key) {
			return byKey.get(key);
		},
		has(ref) {
			return this.get(ref) !== undefined;
		},
		get size() {
			return byKey.size;
		},
		keys() {
			return [...byKey.keys()].sort();
		},
	};
}
