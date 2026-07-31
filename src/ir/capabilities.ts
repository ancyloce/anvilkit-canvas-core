/**
 * @file Capability declaration for a document (plan 0021 T-013, PRD §9.1).
 *
 * ## What `requiredCapabilities` is for
 *
 * It names what a *reader* must implement to open the document correctly. A
 * reader that does not implement a declared capability shows a read-only
 * materialized preview instead of editing the document destructively — see
 * `CanvasDocumentCompatibility`, which explains why the field is an open
 * `string[]` and never a closed enum.
 *
 * ## Computed on SAVE, never on read
 *
 * {@link computeRequiredCapabilities} derives the list from content. Running it
 * on read would defeat the mechanism: a reader that recomputed would silently
 * replace a *newer* writer's declaration with its own narrower view and then
 * edit content it does not understand. The one place this belongs is the write
 * path.
 *
 * ## Declare only what is used
 *
 * A document with no components declares no component capability. Over-declaring
 * is not harmless — it routes readers into read-only preview for features the
 * document does not actually use.
 */

import {
	CANVAS_COMPONENTS_LOCAL_CAPABILITY,
	CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
	CANVAS_LAYOUT_AUTO_CAPABILITY,
	nodeCarriesLayoutIntent,
} from "./invariants.js";
import type { CanvasIR } from "./types.js";
import { walkDocument } from "./walkers.js";

/**
 * A document uses at least one external library component (plan 0021,
 * `components.external.v1`).
 */
export const CANVAS_COMPONENTS_EXTERNAL_CAPABILITY = "components.external.v1";

/**
 * A document persists a variant selection on an instance
 * (`components.variants.v1`).
 *
 * Emitted from M3/T-026, when `CanvasComponentInstanceNode.variantSelection`
 * became the field that carries one. (Declared in M1 ahead of that field so the
 * contract was fixed; see {@link computeRequiredCapabilities}.)
 */
export const CANVAS_COMPONENTS_VARIANTS_CAPABILITY = "components.variants.v1";

/**
 * A document carries a brand policy that a reader must honour
 * (`brand.governance.v1`). Declared now, emitted from M4 (T-036…T-040).
 */
export const CANVAS_BRAND_GOVERNANCE_CAPABILITY = "brand.governance.v1";

/**
 * Derive the capability list this document's CONTENT requires.
 *
 * Returns a sorted, deduplicated list. Unrecognized capabilities already
 * declared on the document are **preserved**, not dropped — that is the
 * load-bearing behaviour here, not a nicety. The IR is CRDT-replicated and its
 * schemas are loose, so a document may legitimately arrive from a newer peer
 * carrying both a capability this build has never heard of and the content that
 * requires it. Recomputing from scratch and writing the result would strip the
 * declaration while keeping the content, producing exactly the silently-editable
 * malformed document the capability mechanism exists to prevent.
 */
export function computeRequiredCapabilities(ir: CanvasIR): readonly string[] {
	const required = new Set<string>();

	// Anything this build understands and can see in the content.
	if (ir.components && Object.keys(ir.components).length > 0) {
		required.add(CANVAS_COMPONENTS_LOCAL_CAPABILITY);
	}
	if (
		ir.externalComponentSnapshots &&
		Object.keys(ir.externalComponentSnapshots).length > 0
	) {
		required.add(CANVAS_COMPONENTS_EXTERNAL_CAPABILITY);
	}

	walkDocument(ir, ({ node }) => {
		if (nodeCarriesLayoutIntent(node)) {
			required.add(CANVAS_LAYOUT_AUTO_CAPABILITY);
		}
		if (node.type !== "component-instance") return;
		// An instance is enough on its own: a document can carry an instance whose
		// Source is missing, and it still requires a reader that understands
		// instances in order not to mangle it.
		if (node.source.kind === "local") {
			required.add(CANVAS_COMPONENTS_LOCAL_CAPABILITY);
		} else {
			required.add(CANVAS_COMPONENTS_EXTERNAL_CAPABILITY);
		}
		if (node.overrides && Object.keys(node.overrides).length > 0) {
			required.add(CANVAS_COMPONENTS_OVERRIDES_CAPABILITY);
		}
		// M1 deferred this trigger because no persisted variant field existed yet
		// and guessing its name would have declared a capability no content
		// carried. T-026 added `variantSelection`, so it is live now. An EMPTY
		// selection does not count: it is indistinguishable from no selection.
		if (
			node.variantSelection &&
			Object.keys(node.variantSelection).length > 0
		) {
			required.add(CANVAS_COMPONENTS_VARIANTS_CAPABILITY);
		}
	});

	// `components.variants.v1` is emitted above, from `variantSelection` (T-026).
	// `brand.governance.v1` still has no field to key off — the policy shape is
	// M4/T-036 — and is deliberately NOT guessed at: emitting a capability keyed
	// on a field name that turns out to be different would declare a requirement
	// no content carries, and over-declaring routes readers into read-only
	// preview for a feature the document does not use. A document arriving from a
	// newer peer that already declares it keeps the declaration through the
	// preservation rule below.

	for (const declared of ir.compatibility?.requiredCapabilities ?? []) {
		required.add(declared);
	}

	return [...required].sort();
}

/**
 * Return `ir` with `compatibility` refreshed from its content — the save-path
 * helper.
 *
 * `compatibility` is omitted entirely when nothing is required, so a plain
 * document stays byte-identical to one written before capabilities existed
 * (the same omit-empty rule `components` follows).
 */
export function withComputedCapabilities(ir: CanvasIR): CanvasIR {
	const requiredCapabilities = computeRequiredCapabilities(ir);
	if (requiredCapabilities.length === 0) {
		if (ir.compatibility === undefined) return ir;
		const { compatibility: _dropped, ...rest } = ir;
		return rest as CanvasIR;
	}
	return {
		...ir,
		compatibility: {
			schemaVersion: ir.version,
			minReaderSchemaVersion:
				ir.compatibility?.minReaderSchemaVersion ?? ir.version,
			requiredCapabilities,
		},
	};
}
