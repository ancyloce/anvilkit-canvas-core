/**
 * Central resource limits for `@anvilkit/canvas-core`.
 *
 * Every cap that bounds untrusted or unbounded input lives here, at layering
 * rank 0 — below `ir/` — so that `ir/walkers.ts` (rank 1) and `clipboard/`
 * (rank 2) can share one definition instead of each owning a private copy.
 * That split is what this module fixes: `MAX_TREE_DEPTH` lived in
 * `ir/walkers.ts` and the clipboard caps in `clipboard/payload.ts`, so there
 * was no single place to review "what does this package refuse to process?".
 *
 * Both original modules still re-export their constants, so this
 * consolidation is not a breaking change for existing importers.
 *
 * **Caps are documented ceilings, not automatic enforcement.** A constant
 * here is only load-bearing where a caller actually checks it; each one below
 * names the code that enforces it, or the task that will.
 */

/**
 * Maximum node nesting depth accepted by the IR walkers.
 *
 * Enforced by `ir/walkers.ts`, which throws `CanvasIRDepthError` past this
 * depth — the guard against a hostile or corrupt document driving unbounded
 * recursion.
 */
export const MAX_TREE_DEPTH = 64;

/** Maximum number of nodes accepted in a single clipboard payload. */
export const MAX_CLIPBOARD_NODES = 1_000;

/** Maximum serialized byte size accepted for a single clipboard payload. */
export const MAX_CLIPBOARD_BYTES = 2 * 1024 * 1024;

/**
 * Largest finite coordinate, extent, padding, or gap magnitude that layout
 * arithmetic is guaranteed to handle without precision loss.
 *
 * Derived, not chosen: layout output is quantised to 1e-4 local units, so a
 * value only round-trips exactly while `value * 1e4` stays inside
 * `Number.MAX_SAFE_INTEGER` (~9.007e15), giving a true ceiling of ~9.007e11.
 * 1e9 sits three orders of magnitude below that, leaving headroom for
 * intermediate sums (a padding + gap + child-extent accumulation across a
 * deep Hug chain) to stay exact rather than merely representable.
 *
 * Values beyond this are rejected as non-finite-equivalent rather than
 * silently producing drifting geometry.
 */
export const MAX_FINITE_LAYOUT_MAGNITUDE = 1e9;

/**
 * Ceiling on nodes in one document, above which whole-document passes
 * (validation, resolution, materialization) are not expected to meet their
 * performance targets.
 *
 * Anchored to the recorded performance workload, which is 1,000 nodes: this
 * allows an order of magnitude beyond the profile that the cold/warm budgets
 * were measured against, so exceeding it means the budgets no longer apply.
 */
export const MAX_DOCUMENT_NODES = 10_000;

/**
 * Ceiling on direct children of a single container.
 *
 * A layout pass over one container is O(children) with a small constant, so
 * this bounds the per-frame cost independently of `MAX_DOCUMENT_NODES` — a
 * single frame holding every node in a document is the pathological shape.
 */
export const MAX_CHILDREN_PER_CONTAINER = 1_000;

/**
 * Ceiling on text-measurement requests issued for one layout resolution.
 *
 * Measurement is the only host-provided (and therefore unbounded-cost) step
 * in an otherwise pure resolver, so it is capped separately from node count.
 */
export const MAX_MEASUREMENT_REQUESTS = 5_000;

/**
 * Ceiling on the character length of a single text-measurement request.
 *
 * Guards the measurement port against a single pathological string rather
 * than a large number of reasonable ones.
 */
export const MAX_MEASUREMENT_TEXT_LENGTH = 100_000;

/**
 * Ceiling on the number of descendants one composite layout command may carry.
 *
 * Applies to `frame.remove-layout` and `selection.wrap-in-layout-frame`, whose
 * payloads are O(descendants): they pass caller-computed resolved geometry for
 * every node they touch. Their inverses carry the prior values for the same
 * set, so a single history entry holds roughly **2× this many geometry
 * records** — value plus inverse. Exceeding the ceiling is a typed
 * `invariant-violated` rejection rather than a silent large allocation.
 *
 * Anchored to `MAX_CLIPBOARD_NODES` (also 1,000), which is this package's
 * existing answer to "how many nodes may one user-initiated bulk operation
 * move at once". A composite layout command is the same kind of operation, so
 * it gets the same budget rather than a second, unrelated number.
 *
 * **Provisional pending OQ-3 sign-off** (PLAN 0022 §2.5, owner: Core
 * maintainer). The enforcement mechanism is what M1 owes; the exact figure is
 * a tuning decision that can move without any code change beyond this line.
 */
export const MAX_COMPOSITE_COMMAND_DESCENDANTS = 1_000;

/**
 * Number of layout diagnostics retained before truncation.
 *
 * Diagnostics are emitted per offending node, so a systematically broken
 * document can produce one per node. Retaining a bounded prefix keeps a
 * diagnostic report reviewable — and keeps its byte size bounded for hosts
 * that persist or transmit it — while the count of dropped entries is
 * reported alongside, so truncation is never silent.
 */
export const MAX_RETAINED_DIAGNOSTICS = 1_000;
