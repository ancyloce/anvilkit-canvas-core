/**
 * @file Dependency-free, deterministic string fingerprints, at layering rank 0.
 *
 * Two consumers need one: `serialize/svg.ts` (rank 5) disambiguates XML ids,
 * and `layout/` (rank 4) builds measurement keys and the resolver's
 * `inputHash`. Rank 5 cannot be imported by rank 4, so before this module the
 * only options were a second copy of the same algorithm or a layering
 * violation. Rank 0 — alongside `clock.ts` and `limits.ts` — is the correct
 * floor: this module imports nothing.
 *
 * **Not cryptographic, and never to be used as if it were.** These are
 * collision-avoidance fingerprints. `node:crypto` is deliberately not used:
 * `canvas-core` runs unchanged in a browser and in a worker, and `crypto.subtle`
 * is async while the resolver's contract is synchronous (TD §8.1).
 */

/**
 * djb2, 32-bit, base-36 encoded.
 *
 * The exact algorithm `serialize/svg.ts` has always used for id
 * disambiguation, moved here **unchanged** — a different hash would rewrite
 * every `url(#…)` reference in the SVG goldens for no behavioural gain.
 */
export function fingerprint(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = (hash * 33) ^ input.charCodeAt(i);
	}
	return (hash >>> 0).toString(36);
}

/**
 * Two independent FNV-1a accumulators concatenated — ~64 bits, base-36.
 *
 * Used where a collision is a **correctness** failure rather than a cosmetic
 * one. `CanvasLayoutMaterialization.inputHash` is the case that forces it: a
 * collision there makes a stale materialized cache read as fresh, so
 * `layout-materialization-stale` never fires and a document renders with
 * geometry from inputs it no longer has. At 32 bits a document set in the tens
 * of thousands is already inside birthday range for that; at 64 it is not.
 *
 * The two accumulators use different offset bases and different primes, so
 * they are not correlated — the pair collides only when both do.
 */
export function fingerprint64(input: string): string {
	// FNV-1a 32-bit offset basis / prime.
	let a = 0x811c9dc5;
	// A second, unrelated basis so the two lanes are independent.
	let b = 0x01000193;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		a ^= c;
		a = Math.imul(a, 0x01000193);
		b ^= c;
		b = Math.imul(b, 0x85ebca6b);
	}
	return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}
