/**
 * @file Export-variant materialization (plan 0023 M3-12, TD §16.5,
 * decision D-2 = MATERIALIZE). An `export-variant` document must be readable
 * by clients with no component support: every page instance is detached
 * through the M3-07 path, the Registry is dropped, and neither component
 * capability is declared. `design` and `template-instance` documents keep
 * their Registry — this transform is ONLY for deriving export variants.
 */

import { applyCommand, CanvasCommandError } from "../commands/runtime.js";
import { buildComponentReferenceIndex } from "../components/graph.js";
import {
	CANVAS_COMPONENTS_LOCAL_CAPABILITY,
	CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
} from "../ir/invariants.js";
import type { CanvasIR } from "../ir/types.js";
import { buildDetachCommand } from "./detach.js";

export interface MaterializeExportVariantOptions {
	/** Fresh-id source for materialized nodes; inject for determinism. */
	idFactory?: () => string;
	/** Injectable clock for the command applications. */
	now?: () => string;
}

/**
 * Derive an `export-variant` document from `ir`: detach every page instance
 * (recursively — Source-tree instances vanish with the Registry), drop
 * `components`, and strip the component capabilities from
 * `compatibility.requiredCapabilities`. Pure — `ir` is never mutated.
 *
 * Throws when any instance cannot resolve: an export of a document with
 * broken component references is an authoring error to surface, not a
 * silently-degraded artifact (NFR-002 applies to edits; export preflight is
 * where "fix your document" belongs).
 */
export function materializeExportVariant(
	ir: CanvasIR,
	options: MaterializeExportVariantOptions = {},
): CanvasIR {
	let working = ir;
	const index = buildComponentReferenceIndex(ir);
	const pageRefs = [...index.pageInstancesByComponent.values()].flat();
	for (const ref of pageRefs) {
		let plan: ReturnType<typeof buildDetachCommand>;
		try {
			plan = buildDetachCommand(working, ref.instanceId, {
				location: { kind: "page", id: ref.pageId },
				...(options.idFactory ? { idFactory: options.idFactory } : {}),
			});
		} catch (err) {
			if (err instanceof CanvasCommandError) {
				throw new CanvasCommandError(
					"invariant-violated",
					`export-variant materialization failed for instance "${ref.instanceId}" on page "${ref.pageId}": ${err.message}`,
				);
			}
			throw err;
		}
		working = applyCommand(working, plan.command, {
			...(options.now ? { now: options.now } : {}),
		}).ir;
	}
	// Destructure BOTH dropped fields out: a conditional spread can only add
	// keys, so leaving `compatibility` inside `rest` would silently carry the
	// unstripped original through when the computed value is `undefined`.
	const {
		components: _dropped,
		compatibility: priorCompatibility,
		...rest
	} = working;
	// `requiredCapabilities` is a REQUIRED field of the compatibility record,
	// so the strip keeps the record with a filtered (possibly empty) list —
	// only a document that declared nothing stays undeclared.
	const compatibility =
		priorCompatibility === undefined
			? undefined
			: {
					...priorCompatibility,
					requiredCapabilities: priorCompatibility.requiredCapabilities.filter(
						(capability) =>
							capability !== CANVAS_COMPONENTS_LOCAL_CAPABILITY &&
							capability !== CANVAS_COMPONENTS_OVERRIDES_CAPABILITY,
					),
				};
	return {
		...rest,
		documentKind: "export-variant",
		...(compatibility !== undefined ? { compatibility } : {}),
	};
}
