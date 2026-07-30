/**
 * @file Detach planning (plan 0023 M3-07, LC-INSTANCE-005). Rank 4
 * (`templates` domain, D-1): composes the rank-2 resolver with the rank-3
 * `component-instance.detach` command — allocating every materialized node
 * id up front through ONE injected factory and returning the COMPLETE
 * virtual→persistent id map, so the caller (selection retargeting, tests,
 * replay) knows the outcome before applying, and the applied command is
 * fully deterministic.
 */

import { CanvasCommandError } from "../commands/runtime.js";
import type { CanvasComponentInstanceDetachCommand } from "../commands/types.js";
import { resolveComponentInstance } from "../components/resolve.js";
import { defaultIdFactory } from "../ir/regenerate-ids.js";
import type {
	CanvasComponentInstanceNode,
	CanvasIR,
	CanvasNode,
} from "../ir/types.js";
import type { CanvasDocumentLocation } from "../ir/walkers.js";
import { findNodeInSubtree, isContainerNode } from "../ir/walkers.js";

export interface BuildDetachCommandOptions {
	/** Tree the instance lives in. Absent = the page tree holding it. */
	location?: CanvasDocumentLocation;
	/** Fresh-id source; inject a deterministic one for replayable plans. */
	idFactory?: () => string;
}

export interface CanvasDetachPlan {
	/** Ready-to-apply command carrying the full id allocation. */
	command: CanvasComponentInstanceDetachCommand;
	/**
	 * COMPLETE resolved-node-id → persistent-id map, root included (the root
	 * keeps the instance's own id — same slot, stable selection).
	 */
	idMap: ReadonlyMap<string, string>;
}

/** Pin the tree the instance lives in: the given location, or its page. */
function resolveLocation(
	ir: CanvasIR,
	location: CanvasDocumentLocation | undefined,
	instanceId: string,
): { location: CanvasDocumentLocation; root: CanvasNode } {
	if (!location) {
		const page = ir.pages.find((p) => findNodeInSubtree(p.root, instanceId));
		if (!page) {
			throw new CanvasCommandError(
				"node-not-found",
				`Instance "${instanceId}" not found on any page`,
			);
		}
		return { location: { kind: "page", id: page.id }, root: page.root };
	}
	const root =
		location.kind === "page"
			? ir.pages.find((p) => p.id === location.id)?.root
			: ir.components?.[location.id]?.root;
	if (!root) {
		throw new CanvasCommandError(
			"location-not-found",
			`${location.kind === "page" ? "Page" : "Component definition"} "${location.id}" not found`,
		);
	}
	return { location, root };
}

/**
 * Resolve the instance fully and allocate a persistent id for every node the
 * detach will materialize. Throws (nothing applied) when the expansion is
 * unsafe — missing Source or a degraded boundary — mirroring the command's
 * own guard so a plan that builds is a plan that applies.
 */
export function buildDetachCommand(
	ir: CanvasIR,
	instanceId: string,
	options: BuildDetachCommandOptions = {},
): CanvasDetachPlan {
	const { location, root } = resolveLocation(ir, options.location, instanceId);
	const found = findNodeInSubtree(root, instanceId);
	if (!found || found.node.type !== "component-instance") {
		throw new CanvasCommandError(
			"node-not-found",
			`Instance "${instanceId}" not found${options.location ? ` in ${options.location.kind} "${options.location.id}"` : ""}`,
		);
	}
	const instance = found.node as CanvasComponentInstanceNode;
	const resolved = resolveComponentInstance(ir.components, instance);
	if (
		resolved.placeholder ||
		resolved.issues.some((issue) => issue.severity === "error")
	) {
		throw new CanvasCommandError(
			"invariant-violated",
			`Cannot plan a detach for "${instanceId}": resolution degraded (${
				resolved.issues[0]?.message ?? "missing Source"
			})`,
		);
	}
	const idFactory = options.idFactory ?? defaultIdFactory;
	const idMap = new Map<string, string>();
	const allocate = (node: CanvasNode, isRoot: boolean): void => {
		idMap.set(node.id, isRoot ? instance.id : idFactory());
		if (isContainerNode(node)) {
			for (const child of node.children) allocate(child, false);
		}
	};
	allocate(resolved.root, true);
	const nodeIds: Record<string, string> = {};
	for (const [virtualId, persistentId] of idMap) {
		if (persistentId !== instance.id) nodeIds[virtualId] = persistentId;
	}
	// The pinned location rides on the command so apply-time resolution finds
	// the instance in the same scope the plan did.
	return {
		command: {
			type: "component-instance.detach",
			nodeId: instanceId,
			nodeIds,
			location,
		},
		idMap,
	};
}
