/**
 * @file Component graph validation (plan 0023 M2-09, TD §19).
 *
 * The reporting/strict pair mirrors the shipped invariant trio
 * (`validateCanvasIRInvariants` / `assertCanvasIRInvariants` /
 * `CanvasIRInvariantError`): `validateComponentGraph` reports,
 * `assertComponentGraph` throws only when an ERROR-severity issue exists —
 * warnings never throw, anywhere.
 *
 * Emits the statically-checkable subset of the 12 codes: cycle, depth,
 * source-missing, duplicate-id, property-target-missing,
 * property-type-invalid, override-orphan, override-type-invalid, and the
 * predictable expanded-node-limit. The remaining three are owned by their
 * flows: `component-materialization-stale` (persist/load, M3),
 * `component-detach-incomplete` (detach, M3),
 * `component-capability-unsupported` (reader gate, M6).
 *
 * Ordering is deterministic (TD §19): graph-level issues over sorted
 * component ids, then per-definition checks in sorted id + property order,
 * then per-instance checks in page/document order.
 */

import type {
	CanvasComponentInstanceNode,
	CanvasComponentProperty,
	CanvasIR,
	CanvasNode,
} from "../ir/types.js";
import { type CanvasDocumentLocation, walkDocument } from "../ir/walkers.js";
import { MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION } from "../limits.js";
import { buildComponentGraph } from "./graph.js";
import { findComponentProperty } from "./identity.js";
import { indexDefinitionNodes } from "./overrides.js";
import type { CanvasComponentIssue } from "./types.js";

/**
 * Does this property's declared target accept this node kind (§10.1)?
 * Exported for the property command handlers (M3-06), which reject an
 * incompatible binding on WRITE — the same table this validator applies on
 * read. Module-level export only; not part of the curated barrel.
 */
export function propertyTargetsNode(
	property: CanvasComponentProperty,
	node: CanvasNode,
): boolean {
	switch (property.kind) {
		case "text":
			return node.type === property.targetKind;
		case "image":
			return property.targetKind === "image"
				? node.type === "image"
				: node.type === "frame" && node.placeholder !== undefined;
		case "color":
			return property.targetField === "background"
				? node.type === "frame"
				: node.type === "rect" ||
						node.type === "ellipse" ||
						node.type === "polygon" ||
						node.type === "star" ||
						node.type === "path" ||
						node.type === "text";
		case "visibility":
			return true;
	}
}

export function validateComponentGraph(ir: CanvasIR): CanvasComponentIssue[] {
	const issues: CanvasComponentIssue[] = [];
	const registry = ir.components ?? {};
	const componentIds = Object.keys(registry).sort();
	const graph = buildComponentGraph(registry);

	for (const cycle of graph.cycles) {
		issues.push({
			code: "component-cycle",
			severity: "error",
			componentId: cycle[0] as string,
			message: `Component dependency cycle: ${[...cycle, cycle[0]].join(" → ")} — cycles are rejected on write and bounded at read.`,
		});
	}
	for (const componentId of graph.depthExceeded) {
		issues.push({
			code: "component-depth-exceeded",
			severity: "error",
			componentId,
			message: `Component "${componentId}"'s nested chain depth ${graph.chainDepths.get(componentId)} exceeds the cap.`,
		});
	}

	// Per-definition: property bindings against the CURRENT Source tree, and
	// nested references against the Registry.
	for (const componentId of componentIds) {
		const definition = registry[componentId];
		if (!definition) continue;
		const nodesById = indexDefinitionNodes(definition.root);
		for (const property of definition.properties) {
			const target = nodesById.get(property.nodeId);
			if (!target) {
				issues.push({
					code: "component-property-target-missing",
					severity: "error",
					componentId,
					propertyId: property.id,
					message: `Property "${property.id}" targets node "${property.nodeId}", which is not in component "${componentId}"'s Source tree.`,
				});
				continue;
			}
			if (!propertyTargetsNode(property, target)) {
				issues.push({
					code: "component-property-type-invalid",
					severity: "error",
					componentId,
					propertyId: property.id,
					sourceNodeId: target.id,
					message: `Property "${property.id}" (${property.kind}) cannot bind node "${target.id}" ("${target.type}").`,
				});
			}
		}
	}

	// Whole-document pass: duplicate ids touching definitions, missing
	// Sources, override validity, and the predictable expansion budget.
	const idLocations = new Map<string, CanvasDocumentLocation[]>();
	const instances: {
		node: CanvasComponentInstanceNode;
		location: CanvasDocumentLocation;
	}[] = [];
	walkDocument(ir, ({ node, location }) => {
		const seen = idLocations.get(node.id);
		if (seen) seen.push(location);
		else idLocations.set(node.id, [location]);
		if (node.type === "component-instance") {
			instances.push({ node, location });
		}
	});

	for (const [id, locations] of idLocations) {
		if (locations.length < 2) continue;
		const componentLocation = locations.find((l) => l.kind === "component");
		if (!componentLocation) continue; // page-only duplicates are the IR invariant's
		issues.push({
			code: "component-duplicate-id",
			severity: "error",
			componentId: componentLocation.id,
			sourceNodeId: id,
			location: componentLocation,
			message: `Node id "${id}" appears in ${locations.length} trees (${locations.map((l) => `${l.kind} ${l.id}`).join(", ")}) — the document is unsafe to edit until ids are unique (INV-2).`,
		});
	}

	// Predictable expansion size per ACYCLIC definition: own nodes plus the
	// full expansion of every nested reference.
	const expandedSize = new Map<string, number>();
	for (const componentId of graph.topologicalOrder) {
		const definition = registry[componentId];
		if (!definition) continue;
		let size = indexDefinitionNodes(definition.root).size;
		for (const dep of graph.dependencies.get(componentId) ?? []) {
			size += expandedSize.get(dep) ?? 0;
		}
		expandedSize.set(componentId, size);
	}

	let predictedTotal = 0;
	for (const { node, location } of instances) {
		const definition = registry[node.componentId];
		if (!definition) {
			issues.push({
				code: "component-source-missing",
				severity: "error",
				componentId: node.componentId,
				instanceId: node.id,
				location,
				message: `Instance "${node.id}" references component "${node.componentId}", which is not in the Registry.`,
			});
			continue;
		}
		predictedTotal += expandedSize.get(node.componentId) ?? 0;
		for (const propertyId of Object.keys(node.overrides ?? {}).sort()) {
			const override = node.overrides?.[propertyId];
			if (!override) continue;
			const property = findComponentProperty(definition, propertyId);
			if (!property) {
				issues.push({
					code: "component-override-orphan",
					severity: "warning",
					componentId: node.componentId,
					instanceId: node.id,
					propertyId,
					location,
					message: `Override "${propertyId}" on instance "${node.id}" has no matching property — retained as an orphan (§10.3).`,
				});
				continue;
			}
			if (property.kind !== override.kind) {
				issues.push({
					code: "component-override-type-invalid",
					severity: "warning",
					componentId: node.componentId,
					instanceId: node.id,
					propertyId,
					location,
					message: `Override "${propertyId}" on instance "${node.id}" is "${override.kind}" but property is "${property.kind}" — retained as invalid, never applied.`,
				});
			}
		}
	}
	if (predictedTotal > MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION) {
		issues.push({
			code: "component-expanded-node-limit",
			severity: "error",
			message: `Instances predictably expand to ${predictedTotal} virtual nodes (cap ${MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION}) — the write introducing this should be rejected.`,
		});
	}

	return issues;
}

/** Thrown by {@link assertComponentGraph}; carries EVERY issue found, not just the first error. */
export class CanvasComponentGraphError extends Error {
	readonly issues: readonly CanvasComponentIssue[];
	constructor(issues: readonly CanvasComponentIssue[]) {
		const errors = issues.filter((i) => i.severity === "error");
		super(
			`Component graph validation failed with ${errors.length} error(s): ${errors
				.map((i) => i.code)
				.join(", ")}`,
		);
		this.name = "CanvasComponentGraphError";
		this.issues = issues;
	}
}

/**
 * Strict gate: throws {@link CanvasComponentGraphError} when any
 * ERROR-severity issue is present. Warning-only documents pass — warnings
 * never throw (TD §19).
 */
export function assertComponentGraph(ir: CanvasIR): void {
	const issues = validateComponentGraph(ir);
	if (issues.some((i) => i.severity === "error")) {
		throw new CanvasComponentGraphError(issues);
	}
}
