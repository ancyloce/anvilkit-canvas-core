import { findNode } from "../ir/walkers.js";
import type { CanvasTemplateDefinition, TemplateSlot } from "./types.js";

/**
 * A cross-reference problem found while checking a {@link CanvasTemplateDefinition}'s
 * `editableSlots`/`lockedNodeIds` against its own `document`. Structured (code +
 * offending id), not a thrown error — schema validation only checks shape, not
 * these referential invariants, so callers decide how to surface them (block
 * instantiation, warn, etc.).
 */
export type TemplateReferenceIssueCode =
	| "slot-node-not-found"
	| "locked-node-not-found";

export interface TemplateReferenceIssue {
	code: TemplateReferenceIssueCode;
	/** The `TemplateSlot.id`, or the `lockedNodeIds` entry itself for that variant. */
	id: string;
	/** The node id that could not be found in `document`. */
	nodeId: string;
}

/**
 * Checks that every {@link TemplateSlot}'s `nodeId` and every `lockedNodeIds`
 * entry on `definition` actually resolves to a node inside `definition.document`.
 * Returns an empty array when everything resolves.
 */
export function validateTemplateReferences(
	definition: CanvasTemplateDefinition,
): TemplateReferenceIssue[] {
	const issues: TemplateReferenceIssue[] = [];
	for (const slot of definition.editableSlots) {
		if (!findNode(definition.document, slot.nodeId)) {
			issues.push({
				code: "slot-node-not-found",
				id: slot.id,
				nodeId: slot.nodeId,
			});
		}
	}
	for (const nodeId of definition.lockedNodeIds) {
		if (!findNode(definition.document, nodeId)) {
			issues.push({ code: "locked-node-not-found", id: nodeId, nodeId });
		}
	}
	return issues;
}

/**
 * Whether `nodeId` is locked by `definition`. The single source of truth for
 * this check — canvas-m2-003's `instantiateTemplate` and any editor-side
 * "can I edit this node" gate must call this rather than re-reading
 * `lockedNodeIds` themselves.
 */
export function isNodeLocked(
	definition: CanvasTemplateDefinition,
	nodeId: string,
): boolean {
	return definition.lockedNodeIds.includes(nodeId);
}

/** A `TemplateVariable` left with no supplied value, no default, and `required: true`. */
export interface TemplateVariableWarning {
	code: "required-variable-missing";
	variableId: string;
	slotId: string;
}

export interface ResolveTemplateVariablesResult {
	/** Resolved value per variable id — supplied value, else `defaultValue`, else absent. */
	values: Record<string, string>;
	warnings: TemplateVariableWarning[];
}

/**
 * Fills in `definition.variables` against a caller-supplied value map: a
 * supplied value wins, otherwise `defaultValue` applies, otherwise a
 * `required` variable produces a structured warning (never a thrown error) and
 * is simply absent from `values`.
 */
export function resolveTemplateVariables(
	definition: CanvasTemplateDefinition,
	values: Readonly<Record<string, string>> = {},
): ResolveTemplateVariablesResult {
	const resolved: Record<string, string> = {};
	const warnings: TemplateVariableWarning[] = [];
	for (const variable of definition.variables) {
		const supplied = values[variable.id];
		if (supplied !== undefined) {
			resolved[variable.id] = supplied;
		} else if (variable.defaultValue !== undefined) {
			resolved[variable.id] = variable.defaultValue;
		} else if (variable.required) {
			warnings.push({
				code: "required-variable-missing",
				variableId: variable.id,
				slotId: variable.slotId,
			});
		}
	}
	return { values: resolved, warnings };
}
