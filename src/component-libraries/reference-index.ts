/**
 * @file The document's external-snapshot reference closure (plan 0021 T-033, TD §19).
 *
 * ## Three sources of a reference, not one
 *
 * A snapshot is reachable if ANY of these points at it, and missing one is how
 * a GC deletes something still in use:
 *
 * 1. an instance on a page,
 * 2. an instance nested inside a **local** Source's tree — local components can
 *    embed external ones,
 * 3. a `dependencies` entry of an external snapshot that is itself reachable —
 *    transitively.
 *
 * (3) is why this is a closure and not a scan: an outer component keeps its
 * dependencies alive even though nothing in the document references them
 * directly.
 *
 * ## It deliberately cannot see history
 *
 * Undo history is Editor-owned (`stores/history-store.ts` holds up to 100 whole
 * `CanvasIR` copies), so Core cannot derive a history closure and does not try.
 * The GC command therefore takes the retained set as a **required** argument —
 * see `commands/collect-unused.ts`.
 */

import { snapshotKey } from "../ir/snapshot-key.js";
import type { CanvasIR, CanvasNode } from "../ir/types.js";

function keyOfSafe(ref: {
	libraryId: string;
	componentId: string;
	version: string;
	integrity: string;
	kind: "library";
}): string | undefined {
	try {
		return snapshotKey(ref);
	} catch {
		return undefined;
	}
}

/** Collect external refs from one node tree, without recursing into snapshots. */
function collectFromTree(root: CanvasNode, into: Set<string>): void {
	const stack: CanvasNode[] = [root];
	while (stack.length > 0) {
		const node = stack.pop() as CanvasNode;
		if (node.type === "component-instance" && node.source.kind === "library") {
			const key = keyOfSafe(node.source);
			if (key !== undefined) into.add(key);
		}
		const children = (node as { children?: readonly CanvasNode[] }).children;
		if (children) {
			for (const child of children) stack.push(child);
		}
	}
}

/**
 * Every snapshot key this document reaches.
 *
 * Pure, and bounded by the document: each snapshot is expanded at most once, so
 * a cyclic or diamond dependency graph terminates and costs O(snapshots) rather
 * than O(paths).
 */
export function collectReferencedSnapshotKeys(
	ir: CanvasIR,
): ReadonlySet<string> {
	const direct = new Set<string>();

	// (1) page trees
	for (const page of ir.pages) collectFromTree(page.root, direct);
	// (2) local Source trees
	for (const definition of Object.values(ir.components ?? {})) {
		collectFromTree(definition.root, direct);
	}

	// (3) transitive closure over snapshot dependencies.
	const registry = ir.externalComponentSnapshots ?? {};
	const reachable = new Set<string>();
	const queue = [...direct];
	while (queue.length > 0) {
		const key = queue.pop() as string;
		// Counted exactly once even when reached by several paths.
		if (reachable.has(key)) continue;
		reachable.add(key);

		const snapshot = registry[key];
		if (!snapshot) continue;
		// A snapshot's own tree may embed further external instances beyond what
		// its `dependencies` manifest lists; both are followed.
		const nested = new Set<string>();
		collectFromTree(snapshot.definition.root, nested);
		for (const dependency of snapshot.dependencies) {
			const dependencyKey = keyOfSafe(dependency);
			if (dependencyKey !== undefined) nested.add(dependencyKey);
		}
		for (const next of nested) {
			if (!reachable.has(next)) queue.push(next);
		}
	}

	return reachable;
}

/**
 * Snapshot keys stored but not reachable from the document.
 *
 * "Unreferenced by this document" — NOT "safe to delete". Undo history may still
 * need them, which is why the GC command unions this with a caller-supplied
 * retained set rather than acting on it alone.
 */
export function collectUnreferencedSnapshotKeys(
	ir: CanvasIR,
): readonly string[] {
	const referenced = collectReferencedSnapshotKeys(ir);
	return Object.keys(ir.externalComponentSnapshots ?? {})
		.filter((key) => !referenced.has(key))
		.sort();
}
