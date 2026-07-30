/**
 * @file Typed override application (plan 0023 M2-04, TD §10.1–10.3).
 *
 * Applies one instance's override map to RUNTIME VIEWS of its definition's
 * nodes. Pure: never mutates the definition tree, the override map, or any
 * input node (INV-4); the persisted map is preserved verbatim — an invalid
 * entry is skipped with a diagnostic, never dropped or reassigned (INV-6,
 * orphan lifecycle §10.3). Deterministic: entries are processed sorted by
 * Property ID, so identical inputs produce identical patches AND identical
 * diagnostic order (INV-5).
 */

import type {
	CanvasComponentDefinition,
	CanvasComponentOverride,
	CanvasComponentOverrideMap,
	CanvasComponentProperty,
	CanvasNode,
} from "../ir/types.js";
import { isContainerNode } from "../ir/walkers.js";
import { findComponentProperty } from "./identity.js";
import type { CanvasComponentIssue } from "./types.js";

export interface CanvasAppliedOverrides {
	/**
	 * definitionNodeId → replacement runtime view. Only patched nodes appear;
	 * every other node of the Source tree is shared by reference. Multiple
	 * overrides targeting one node compose into a single replacement.
	 */
	readonly patches: ReadonlyMap<string, CanvasNode>;
	readonly issues: readonly CanvasComponentIssue[];
}

/**
 * Index a Source tree by node id — the definition-structural lookup the
 * applier (and the resolver's expansion pass) works against.
 */
export function indexDefinitionNodes(
	root: CanvasNode,
): ReadonlyMap<string, CanvasNode> {
	const byId = new Map<string, CanvasNode>();
	const stack: CanvasNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop() as CanvasNode;
		byId.set(node.id, node);
		if (isContainerNode(node)) {
			for (const child of node.children) stack.push(child);
		}
	}
	return byId;
}

interface ApplyContext {
	readonly definition: CanvasComponentDefinition;
	readonly instanceId?: string;
	readonly issues: CanvasComponentIssue[];
}

function issueFor(
	ctx: ApplyContext,
	code: CanvasComponentIssue["code"],
	propertyId: string,
	message: string,
	sourceNodeId?: string,
): void {
	ctx.issues.push({
		code,
		severity: "warning",
		componentId: ctx.definition.id,
		...(ctx.instanceId !== undefined ? { instanceId: ctx.instanceId } : {}),
		...(sourceNodeId !== undefined ? { sourceNodeId } : {}),
		propertyId,
		message,
	});
}

/**
 * The TD §10.1 resolution table, one property/override pair at a time.
 * Returns the patched runtime view, or `null` after emitting the diagnostic
 * that explains why nothing was applied.
 */
function applyOne(
	ctx: ApplyContext,
	property: CanvasComponentProperty,
	override: CanvasComponentOverride,
	target: CanvasNode,
): CanvasNode | null {
	if (property.kind !== override.kind) {
		issueFor(
			ctx,
			"component-override-type-invalid",
			property.id,
			`Override for property "${property.id}" is "${override.kind}" but the property is "${property.kind}" — retained as invalid, not applied.`,
			target.id,
		);
		return null;
	}
	switch (override.kind) {
		case "text": {
			if (
				property.kind === "text" &&
				property.targetKind === "text" &&
				target.type === "text" &&
				override.value.kind === "plain"
			) {
				return { ...target, text: override.value.text };
			}
			if (
				property.kind === "text" &&
				property.targetKind === "rich-text" &&
				target.type === "rich-text" &&
				override.value.kind === "rich"
			) {
				// `paragraphs` ONLY — width/sizing/overflow stay the Source's.
				return { ...target, paragraphs: override.value.paragraphs };
			}
			issueFor(
				ctx,
				"component-property-type-invalid",
				property.id,
				`Text property "${property.id}" targets a "${target.type}" node with a "${override.value.kind}" value — the §10.1 pairs are text/plain and rich-text/rich.`,
				target.id,
			);
			return null;
		}
		case "image": {
			if (target.type === "image") {
				return { ...target, assetId: override.assetId };
			}
			if (target.type === "frame" && target.placeholder) {
				return {
					...target,
					placeholder: { ...target.placeholder, assetId: override.assetId },
				};
			}
			issueFor(
				ctx,
				"component-property-type-invalid",
				property.id,
				target.type === "frame"
					? `Image property "${property.id}" targets frame "${target.id}", which has no placeholder to bind.`
					: `Image property "${property.id}" targets a "${target.type}" node — only image nodes and placeholder frames accept it.`,
				target.id,
			);
			return null;
		}
		case "color": {
			const field = property.kind === "color" ? property.targetField : "fill";
			if (field === "background" && target.type === "frame") {
				return { ...target, background: override.value };
			}
			if (
				field === "fill" &&
				(target.type === "rect" ||
					target.type === "ellipse" ||
					target.type === "polygon" ||
					target.type === "star" ||
					target.type === "path" ||
					target.type === "text")
			) {
				return { ...target, fill: override.value };
			}
			issueFor(
				ctx,
				"component-property-type-invalid",
				property.id,
				`Color property "${property.id}" declares target field "${field}", which node "${target.id}" ("${target.type}") does not carry.`,
				target.id,
			);
			return null;
		}
		case "visibility":
			return { ...target, visible: override.visible };
	}
}

/**
 * Apply an override map to runtime views of `definition`'s nodes
 * (TD §10.2, in order): look up the property by ID → verify the target node
 * still exists → verify type compatibility → patch a runtime view — or emit
 * the orphan/type diagnostic and skip.
 */
export function applyComponentOverrides(
	definition: CanvasComponentDefinition,
	overrides: CanvasComponentOverrideMap | undefined,
	options: { instanceId?: string } = {},
): CanvasAppliedOverrides {
	const issues: CanvasComponentIssue[] = [];
	const patches = new Map<string, CanvasNode>();
	if (!overrides || Object.keys(overrides).length === 0) {
		return { patches, issues };
	}
	const ctx: ApplyContext = {
		definition,
		...(options.instanceId !== undefined
			? { instanceId: options.instanceId }
			: {}),
		issues,
	};
	const nodesById = indexDefinitionNodes(definition.root);

	for (const propertyId of Object.keys(overrides).sort()) {
		const override = overrides[propertyId] as CanvasComponentOverride;
		const property = findComponentProperty(definition, propertyId);
		if (!property) {
			issueFor(
				ctx,
				"component-override-orphan",
				propertyId,
				`Override "${propertyId}" has no matching property on component "${definition.id}" — retained as an orphan, never reassigned (§10.3).`,
			);
			continue;
		}
		// Compose with any earlier patch so several overrides on one node
		// (e.g. color + visibility) all land on one replacement view.
		const target =
			patches.get(property.nodeId) ?? nodesById.get(property.nodeId);
		if (!target) {
			issueFor(
				ctx,
				"component-property-target-missing",
				propertyId,
				`Property "${propertyId}" targets node "${property.nodeId}", which no longer exists in component "${definition.id}" — override ignored.`,
			);
			continue;
		}
		const patched = applyOne(ctx, property, override, target);
		if (patched) patches.set(property.nodeId, patched);
	}
	return { patches, issues };
}
