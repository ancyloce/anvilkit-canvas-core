/**
 * @file Type surface of the `components/` domain (plan 0023 M1-02/03).
 *
 * The PERSISTED component shapes live in `ir/types.ts` (rank 1) — see the
 * layering note in `index.ts` — and are re-exported here so consumers can
 * treat `components/` as the domain's home. Resolver-side contracts
 * (virtual paths, resolved-origin records) join them in M2.
 */

import type { CanvasDocumentLocation } from "../ir/walkers.js";

export type {
	CanvasComponentColorProperty,
	CanvasComponentDefinition,
	CanvasComponentImageProperty,
	CanvasComponentInstanceNode,
	CanvasComponentOverride,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
	CanvasComponentPropertyBase,
	CanvasComponentRegistry,
	CanvasComponentTextProperty,
	CanvasComponentVisibilityProperty,
	CanvasTextOverrideValue,
} from "../ir/types.js";

/**
 * The 12 stable diagnostic codes (PRD §9.12). GROW-ONLY once shipped: hosts
 * switch on these to phrase user-facing messages, so a removed or renamed
 * member is a breaking change.
 */
export type CanvasComponentIssueCode =
	| "component-source-missing"
	| "component-cycle"
	| "component-depth-exceeded"
	| "component-expanded-node-limit"
	| "component-duplicate-id"
	| "component-property-target-missing"
	| "component-property-type-invalid"
	| "component-override-orphan"
	| "component-override-type-invalid"
	| "component-materialization-stale"
	| "component-detach-incomplete"
	| "component-capability-unsupported";

/**
 * One component diagnostic (TD §19). `severity: "warning"` never throws
 * anywhere — `assertComponentGraph` is the strict gate for `"error"` issues
 * only, mirroring the shipped invariant trio.
 */
export interface CanvasComponentIssue {
	readonly code: CanvasComponentIssueCode;
	readonly severity: "warning" | "error";
	readonly componentId?: string;
	readonly instanceId?: string;
	readonly sourceNodeId?: string;
	readonly propertyId?: string;
	readonly location?: CanvasDocumentLocation;
	readonly message: string;
}

/**
 * Component provenance of one resolved record (plan 0023 M2-03, TD §9.3) —
 * the additive optional field `CanvasResolvedNodeRecord.component` carries.
 * Additive by contract: every existing `CanvasResolvedDocument` consumer
 * keeps working unchanged on component-free documents, where the field is
 * absent on every record.
 */
export interface CanvasResolvedComponentOrigin {
	/**
	 * The instance node that produced this record — its IMMEDIATE owner, which is
	 * a persistent document id only at `depth: 1`.
	 *
	 * Inside a NESTED instance this is the nested instance's own VIRTUAL id: the
	 * expansion threads that codec id down as the child pass's instance id, so a
	 * record two definitions deep reports something like
	 * `akv1:6:inst-112:outer-nested`, which addresses no document node. A
	 * consumer that needs the persistent instance a record ultimately belongs to
	 * (selection, commands, anything persisted) must follow the owner chain to
	 * its fixed point — the record whose origin names itself. Editor-side that is
	 * `persistentInstanceIdFor` in `selection/component-selection-policy.ts`.
	 */
	readonly instanceId: string;
	readonly componentId: string;
	/**
	 * ID of the node inside the definition tree. Distinct from
	 * `sourceNodeId`, which stays the record's own addressing field.
	 */
	readonly definitionNodeId: string;
	/** Expansion depth; 1 for a top-level instance's own subtree. */
	readonly depth: number;
}
