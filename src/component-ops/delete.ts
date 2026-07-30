/**
 * @file "Detach all and delete" planning (plan 0023 M3-08, LC-DELETE).
 * Rank 4 (`templates` domain): pre-resolves EVERY dependent of a component
 * — Source-tree instances first, hosts in reverse topological order, then
 * page instances — into one atomic batch that ends with `component.delete`.
 * The batch commits only if every materialization succeeds: any degraded
 * resolution throws mid-application and the all-or-nothing batch discards
 * everything, and a reference the plan somehow missed still trips the
 * delete's own zero-reference guard. The delete's inverse restores the
 * `components` key itself when the last definition goes (INV-10).
 */

import { CanvasCommandError } from "../commands/runtime.js";
import type { CanvasBatchCommand } from "../commands/types.js";
import {
	buildComponentGraph,
	buildComponentReferenceIndex,
} from "../components/graph.js";
import type { CanvasIR } from "../ir/types.js";
import { buildDetachCommand, type CanvasDetachPlan } from "./detach.js";

export interface BuildDetachAllAndDeleteOptions {
	/** Fresh-id source for every materialized node; inject for determinism. */
	idFactory?: () => string;
}

export interface CanvasDetachAllAndDeletePlan {
	/** One atomic batch: detaches (Sources first, reverse-topo), then the delete. */
	command: CanvasBatchCommand;
	/** Per-instance detach plans, in batch order — complete id maps included. */
	detachPlans: readonly CanvasDetachPlan[];
}

export function buildDetachAllAndDeleteCommand(
	ir: CanvasIR,
	componentId: string,
	options: BuildDetachAllAndDeleteOptions = {},
): CanvasDetachAllAndDeletePlan {
	const definition = ir.components?.[componentId];
	if (!definition) {
		throw new CanvasCommandError(
			"location-not-found",
			`Component definition "${componentId}" not found`,
		);
	}
	const index = buildComponentReferenceIndex(ir);
	const graph = buildComponentGraph(ir.components ?? {});

	// Source-tree dependents grouped by host definition.
	const instancesByHost = new Map<string, string[]>();
	for (const ref of index.sourceDependenciesByComponent.get(componentId) ??
		[]) {
		const list = instancesByHost.get(ref.componentId) ?? [];
		list.push(ref.instanceId);
		instancesByHost.set(ref.componentId, list);
	}
	// Hosts in REVERSE topological order (containers before their nested
	// definitions); cycle members carry no topological slot, so any
	// cycle-resident host is appended in sorted order rather than dropped.
	const hostOrder = [...graph.topologicalOrder].reverse();
	const unordered = [...instancesByHost.keys()]
		.filter((host) => !hostOrder.includes(host))
		.sort();
	const plans: CanvasDetachPlan[] = [];
	for (const host of [...hostOrder, ...unordered]) {
		for (const instanceId of instancesByHost.get(host) ?? []) {
			plans.push(
				buildDetachCommand(ir, instanceId, {
					location: { kind: "component", id: host },
					...(options.idFactory ? { idFactory: options.idFactory } : {}),
				}),
			);
		}
	}
	for (const ref of index.pageInstancesByComponent.get(componentId) ?? []) {
		plans.push(
			buildDetachCommand(ir, ref.instanceId, {
				location: { kind: "page", id: ref.pageId },
				...(options.idFactory ? { idFactory: options.idFactory } : {}),
			}),
		);
	}
	const command: CanvasBatchCommand = {
		type: "batch",
		label: `Detach all and delete "${definition.name}"`,
		commands: [
			...plans.map((plan) => plan.command),
			{ type: "component.delete", componentId },
		],
	};
	return { command, detachPlans: plans };
}
