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

// --- Local Components caps (plan 0023 M1-07, decision D-3) ------------------
// Derived from the M0-03 pre-component baseline
// (`bench/baselines/pre-component.json`: 3,000 plain nodes resolve at
// ~16.6 ms median / 25 ms p95 on the reference host), not from intuition.
// Enforcement: schema caps are checked by `ir/validators.ts`; graph/expansion
// caps by the M2 resolver + `validateComponentGraph` (M2-02/M2-09).

/**
 * Ceiling on Component Sources in one document's `ir.components` Registry.
 * A document-local library; generous against real marketing documents while
 * keeping a hostile Registry parse bounded. Enforced by `ir/validators.ts`.
 */
export const MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT = 256;

/**
 * Ceiling on nodes in one definition's Source tree — ~1/6 of the measured
 * 3,000-node baseline document, so even a page of maximum-size instances
 * stays inside the profiled envelope. Enforced by `ir/validators.ts`.
 */
export const MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION = 512;

/** Ceiling on exposed properties per definition. Enforced by `ir/validators.ts`. */
export const MAX_COMPONENT_PROPERTIES_PER_COMPONENT = 64;

/**
 * Ceiling on override-map entries per instance — 2× the properties cap,
 * because orphaned overrides are retained rather than dropped (TD §10.3).
 * Enforced by `ir/validators.ts`.
 */
export const MAX_COMPONENT_OVERRIDES_PER_INSTANCE = 128;

/**
 * Ceiling on nested component depth (instance → Source → instance …).
 * Well under `MAX_TREE_DEPTH` (64) so an expanded virtual tree can never
 * approach the walker guard even atop a deep page subtree. Enforced by the
 * M2 dependency graph (`validateComponentGraph`) and again at read time.
 */
export const MAX_COMPONENT_NESTED_DEPTH = 16;

/**
 * Ceiling on virtual nodes one resolution pass may expand. Anchored to
 * `MAX_DOCUMENT_NODES` — expansion output IS a document-scale node set, and
 * beyond that figure the measured budgets no longer apply. Enforced by the
 * M2 resolver (placeholder + diagnostic past the cap, never a throw).
 */
export const MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION = MAX_DOCUMENT_NODES;

/**
 * Ceiling on characters carried by ONE text override — plain string length,
 * or the summed span text of a rich value. Bounds a hostile override without
 * constraining real copy (the measurement port itself accepts
 * `MAX_MEASUREMENT_TEXT_LENGTH` = 100k). Enforced by `ir/validators.ts`.
 */
export const MAX_COMPONENT_TEXT_OVERRIDE_CHARS = 10_000;

/** Ceiling on paragraphs in one rich text override. Enforced by `ir/validators.ts`. */
export const MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE = 200;

/** Ceiling on spans per paragraph in a rich text override. Enforced by `ir/validators.ts`. */
export const MAX_COMPONENT_RICH_SPANS_PER_PARAGRAPH = 100;

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

// --- External Component Library caps (plan 0021 T-009, TD 0016 §22.2) -------
//
// These bound an **untrusted remote Provider envelope** before any
// allocation-heavy work (TD §22.2: "bounded schemas before allocation-heavy
// work"). They live here rather than in `component-libraries/limits.ts` as the
// plan proposed, for two reasons: this module already declares itself the one
// place every cap lives, and rank 0 is the only rank `ir/` (rank 1) can reach —
// which M1 needs, because the persisted snapshot registry is validated in
// `ir/validators.ts` and a rank-4 module would be unreachable from there.
//
// Where an external component bounds the *same quantity* as a local one, the
// local constant is reused rather than shadowed by a near-duplicate: definition
// node count (`MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION`), expanded nodes
// (`MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION`), exposed properties
// (`MAX_COMPONENT_PROPERTIES_PER_COMPONENT`), and instance overrides
// (`MAX_COMPONENT_OVERRIDES_PER_INSTANCE`) all apply unchanged to an external
// definition. Two caps for one quantity is how the looser one silently becomes
// the real limit.

/**
 * Ceiling on the serialized byte size of one Provider envelope.
 *
 * Anchored to `MAX_CLIPBOARD_BYTES` (also 2 MiB), which is this package's
 * existing answer to "how many bytes may a single untrusted payload carry".
 * An envelope is the same kind of object: one-shot, externally supplied, parsed
 * once. It carries at most one definition (≤
 * `MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION` nodes) plus its dependency refs,
 * which is a smaller shape than the ≤1,000-node clipboard payload the figure was
 * set for — so it is a ceiling with headroom, not a target.
 *
 * Checked against the transport-reported length **before** full parse where the
 * transport provides one (TD §23.3).
 */
export const MAX_EXTERNAL_ENVELOPE_BYTES = MAX_CLIPBOARD_BYTES;

/**
 * Ceiling on entries in one document's `externalComponentSnapshots` registry.
 *
 * Anchored to `MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT` (256): a snapshot
 * registry is the cross-document analogue of the local Component Registry, so it
 * gets the same budget rather than a second unrelated number. Note that distinct
 * *versions* of one component occupy distinct entries (the key includes version
 * and integrity), which is what makes explicit GC (`component-snapshot.collect-unused`)
 * necessary rather than optional.
 */
export const MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT =
	MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT;

/**
 * Ceiling on **direct** dependency references declared by one external
 * definition — the fan-out guard against a dependency bomb (TD §22.1).
 *
 * Anchored to `MAX_COMPONENT_PROPERTIES_PER_COMPONENT` (64): a definition's
 * dependency list and its property list are the same order of structural
 * complexity, and a component needing more than 64 direct dependencies is not a
 * component.
 *
 * Fan-out alone does not bound total work — `MAX_EXTERNAL_DEPENDENCY_DEPTH`
 * bounds the other axis, and `MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION` bounds
 * the product. All three are enforced **after** expansion, not before, because a
 * bomb is cheap to declare and expensive to expand.
 */
export const MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT =
	MAX_COMPONENT_PROPERTIES_PER_COMPONENT;

/**
 * Ceiling on dependency-closure depth (component → depends on → component …).
 *
 * The same axis as `MAX_COMPONENT_NESTED_DEPTH`, measured across libraries
 * instead of within one document, so it takes the same value: a closure and a
 * nested-instance chain both expand into the same virtual tree, and that tree is
 * what must stay clear of the `MAX_TREE_DEPTH` (64) walker guard. Giving them
 * different values would mean a mixed local/external chain could exceed whichever
 * limit was checked.
 */
export const MAX_EXTERNAL_DEPENDENCY_DEPTH = MAX_COMPONENT_NESTED_DEPTH;

/**
 * Ceiling on variant axes declared by one component (TD §11.1).
 *
 * Chosen for the shape real design systems use — size, tone, state, density,
 * emphasis — where five or six axes is already unusual. The cap matters because
 * axes multiply: the canonical selection key sorts and encodes every axis, so
 * this also bounds key length.
 */
export const MAX_COMPONENT_VARIANT_AXES = 8;

/** Ceiling on distinct values one variant axis may declare. */
export const MAX_COMPONENT_VARIANT_VALUES_PER_AXIS = 16;

/**
 * Ceiling on **stored** variant definitions for one component.
 *
 * This is the load-bearing variant cap, and it is deliberately not the product
 * of the two above. Variants are *sparse* (PRD §9.6): 8 axes × 16 values is
 * 16^8 dense combinations, a number no cap on axes or values alone would ever
 * bound. Only the count actually present in the payload can be checked, so that
 * is what is capped. Anchored to `MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT` (256) as
 * the package's standing figure for "entries in one keyed registry".
 */
export const MAX_COMPONENT_VARIANTS_PER_COMPONENT = 256;

/**
 * Ceiling on characters in one field of an exact external reference
 * (`libraryId`, `componentId`, `version`, `integrity`).
 *
 * Fixed by TD §5.3, which requires each decoded snapshot-key segment to be
 * 1–256 characters. Declared once here so the key codec and the reference schema
 * cannot disagree — they validate the same bound from the same constant.
 */
export const MAX_EXTERNAL_REF_FIELD_CHARS = 256;

/**
 * Ceiling on characters in a Provider-supplied URL (release notes, thumbnail,
 * deep link).
 *
 * 2,048 is the de-facto interoperable URL ceiling across browsers, servers, and
 * log pipelines. Length is checked in addition to `sanitizeProviderUrl`'s scheme
 * allowlist, because a scheme-valid megabyte URL is still a denial-of-service
 * vector against whatever renders or persists it.
 */
export const MAX_EXTERNAL_URL_CHARS = 2_048;

/**
 * Ceiling on characters in a non-authoritative catalog display string (name,
 * description, publisher, deprecation notice).
 *
 * Catalog metadata is excluded from integrity bytes (TD §5.4), so it is the one
 * part of an envelope no digest constrains — bounding it here is the only guard
 * it gets.
 */
export const MAX_EXTERNAL_DISPLAY_STRING_CHARS = 512;
