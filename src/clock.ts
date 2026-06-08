/**
 * Shared clock seam for `@anvilkit/canvas-core`.
 *
 * Every timestamp-stamping builder/mutation/command accepts an injectable
 * `now: () => string` (so tests get deterministic `createdAt`/`updatedAt`) and
 * falls back to {@link nowIso}. Centralising it here keeps that fallback — and
 * the injection contract — identical across `ir-builders`, `ir-mutations`, and
 * the command runtime instead of three private copies.
 */
export function nowIso(): string {
	return new Date().toISOString();
}

/** Resolve an optional injected clock to a concrete `() => string`. */
export function resolveNow(now?: () => string): () => string {
	return now ?? nowIso;
}
