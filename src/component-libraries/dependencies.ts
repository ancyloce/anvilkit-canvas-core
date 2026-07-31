/**
 * @file External dependency closure validation (plan 0021 T-017, TD 0016 §9.2).
 *
 * ## Commit the whole closure, or commit nothing
 *
 * An external component may reference other external components. A document
 * that stores the outer snapshot but not its dependencies renders a hole: the
 * outer component expands, the nested instance finds no snapshot, and the user
 * sees a placeholder inside an otherwise-correct component with no obvious
 * cause. So the closure is validated *before* anything is committed, and a
 * partial closure is a rejection rather than a partial write.
 *
 * ## Caps are enforced AFTER expansion
 *
 * A dependency bomb is cheap to declare and expensive to expand: 64 direct
 * dependencies each with 64 of their own is four thousand components from a
 * tiny envelope. Fan-out, depth, and total expanded nodes are therefore all
 * checked against the walked closure, not against the declared list — see
 * `limits.ts`, which states the same rule for the constants themselves.
 */

import { collectNestedSourceRefs } from "../components/graph.js";
import { componentSourceLabel } from "../ir/component-source.js";
import { snapshotKey } from "../ir/snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
} from "../ir/types.js";
import {
	MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
	MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT,
	MAX_EXTERNAL_DEPENDENCY_DEPTH,
} from "../limits.js";
import {
	type CanvasComponentDiagnostic,
	componentDiagnostic,
} from "./diagnostics.js";

/**
 * A reference from one external component to another.
 *
 * An alias of {@link CanvasExternalComponentRef} rather than a distinct shape:
 * a dependency IS an exact reference, and giving it its own type would invite
 * the two to drift into "almost the same" — at which point a dependency could
 * express something a reference cannot, e.g. a range.
 */
export type CanvasComponentDependencyRef = CanvasExternalComponentRef;

/**
 * How to look up a snapshot while walking a closure.
 *
 * Optional at the admission boundary: an envelope arrives before any document
 * context, so admission can only run the checks that need no registry —
 * declared-vs-actual references, fan-out, depth, expanded-node count, and the
 * no-local-references rule. Presence of the closure is re-checked by the
 * command that commits (T-021), which does have the document.
 */
export interface ClosureResolver {
	/** Already-admitted snapshots (the document's registry). */
	get(
		ref: CanvasExternalComponentRef,
	): CanvasExternalComponentSnapshot | undefined;
}

export interface ValidateExternalClosureOptions {
	/**
	 * Snapshots admitted in the SAME transaction but not yet in the document.
	 *
	 * Without this, inserting a component together with its dependencies could
	 * never validate: each would be checked against a registry that does not yet
	 * contain the others, so a legal multi-snapshot insert would look like a
	 * partial closure.
	 */
	readonly pending?: readonly CanvasExternalComponentSnapshot[];
	readonly maxDepth?: number;
	readonly maxExpandedNodes?: number;
}

function countNodes(root: unknown): number {
	let count = 0;
	const stack: unknown[] = [root];
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node || typeof node !== "object") continue;
		count += 1;
		const children = (node as { children?: unknown }).children;
		if (Array.isArray(children)) {
			for (const child of children) stack.push(child);
		}
	}
	return count;
}

/**
 * Validate one snapshot's full external dependency closure.
 *
 * Returns `null` when the closure is complete, acyclic, and within every cap;
 * otherwise the diagnostic explaining the first problem found. Never throws —
 * this runs inside `admitExternalSnapshot`, where every rejection is an
 * expected outcome the UI surfaces by code.
 */
export function validateExternalClosure(
	snapshot: CanvasExternalComponentSnapshot,
	resolver: ClosureResolver | undefined,
	options: ValidateExternalClosureOptions = {},
): CanvasComponentDiagnostic | null {
	const maxDepth = options.maxDepth ?? MAX_EXTERNAL_DEPENDENCY_DEPTH;
	const maxNodes =
		options.maxExpandedNodes ?? MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION;

	// A snapshot that lists ITSELF is a cycle of length one, and unlike a longer
	// cycle it needs no registry to see (plan 0021 T-048). Checking it here
	// matters because `closureResolver` is optional: without this, an envelope
	// admitted with no resolver — the documented, supported case — would pass
	// closure validation while being trivially self-referential.
	let selfKey: string | undefined;
	try {
		selfKey = snapshotKey(snapshot.ref);
	} catch {
		selfKey = undefined;
	}
	if (selfKey !== undefined) {
		for (const dependency of snapshot.dependencies ?? []) {
			let dependencyKey: string;
			try {
				dependencyKey = snapshotKey(dependency);
			} catch {
				continue;
			}
			if (dependencyKey === selfKey) {
				return componentDiagnostic(
					"component-dependency-missing",
					`Snapshot "${selfKey}" declares itself as a dependency (cycle).`,
				);
			}
		}
	}

	const pending = new Map<string, CanvasExternalComponentSnapshot>();
	for (const entry of options.pending ?? []) {
		try {
			pending.set(snapshotKey(entry.ref), entry);
		} catch {
			// An unkeyable pending entry cannot satisfy any dependency; ignoring it
			// here makes it surface as the missing dependency it effectively is.
		}
	}

	const lookup = (
		ref: CanvasExternalComponentRef,
	): CanvasExternalComponentSnapshot | undefined => {
		let key: string;
		try {
			key = snapshotKey(ref);
		} catch {
			return undefined;
		}
		return pending.get(key) ?? resolver?.get(ref);
	};

	let expandedNodes = 0;
	const visited = new Set<string>();
	// The DFS path, for cycle detection and a readable cycle message.
	const path: string[] = [];

	const walk = (
		current: CanvasExternalComponentSnapshot,
		depth: number,
	): CanvasComponentDiagnostic | null => {
		let key: string;
		try {
			key = snapshotKey(current.ref);
		} catch (error) {
			return componentDiagnostic(
				"component-snapshot-invalid",
				`dependency reference cannot be keyed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (path.includes(key)) {
			return componentDiagnostic(
				"component-dependency-missing",
				`external dependency cycle: ${[...path, key].join(" → ")}. A component cannot transitively depend on itself.`,
				{ snapshotKey: key },
			);
		}
		// Depth is checked BEFORE the visited short-circuit: a diamond
		// (A→B, A→C, B→D, C→D) legitimately reaches D twice, but a chain that is
		// too deep must fail even if every member was seen on a shallower path.
		if (depth > maxDepth) {
			return componentDiagnostic(
				"component-dependency-missing",
				`external dependency chain is ${depth} deep, exceeding the ${maxDepth} cap (${[...path, key].join(" → ")}).`,
				{ snapshotKey: key },
			);
		}
		if (visited.has(key)) return null;
		visited.add(key);

		if (current.dependencies.length > MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT) {
			return componentDiagnostic(
				"component-snapshot-invalid",
				`component "${componentSourceLabel(current.ref)}" declares ${current.dependencies.length} direct dependencies (max ${MAX_EXTERNAL_DEPENDENCIES_PER_COMPONENT}).`,
				{ snapshotKey: key },
			);
		}

		expandedNodes += countNodes(current.definition.root);
		if (expandedNodes > maxNodes) {
			return componentDiagnostic(
				"component-snapshot-invalid",
				`external closure expands to more than ${maxNodes} nodes; refusing to admit it.`,
				{ snapshotKey: key },
			);
		}

		// Every reference the TREE actually makes must be declared and external.
		const declared = new Set<string>();
		for (const dependency of current.dependencies) {
			try {
				declared.add(snapshotKey(dependency));
			} catch {
				return componentDiagnostic(
					"component-snapshot-invalid",
					`component "${componentSourceLabel(current.ref)}" declares a dependency whose reference is malformed.`,
					{ snapshotKey: key },
				);
			}
		}
		for (const nested of collectNestedSourceRefs(current.definition.root)) {
			if (nested.kind === "local") {
				// An external component cannot reach into THIS document's registry:
				// its meaning would change per document, which is the opposite of
				// what an integrity-pinned snapshot is for.
				return componentDiagnostic(
					"component-snapshot-invalid",
					`component "${componentSourceLabel(current.ref)}" contains an instance of local component "${nested.componentId}". An external component may only reference other external components.`,
					{ snapshotKey: key },
				);
			}
			let nestedKey: string;
			try {
				nestedKey = snapshotKey(nested);
			} catch {
				return componentDiagnostic(
					"component-snapshot-invalid",
					`component "${componentSourceLabel(current.ref)}" contains an instance with a malformed reference.`,
					{ snapshotKey: key },
				);
			}
			if (!declared.has(nestedKey)) {
				// A tree reference the manifest did not declare would be fetched by
				// nobody and silently render as a hole.
				return componentDiagnostic(
					"component-dependency-missing",
					`component "${componentSourceLabel(current.ref)}" contains an instance of "${componentSourceLabel(nested)}", which it does not declare as a dependency.`,
					{ snapshotKey: key },
				);
			}
		}

		path.push(key);
		for (const dependency of current.dependencies) {
			const next = lookup(dependency);
			if (!next) {
				// With no resolver there is no registry to be absent FROM, so
				// "not present" is not a finding — every structural check above
				// still ran, and presence is re-checked by the command that
				// actually commits (T-021) with the document in hand.
				if (resolver === undefined && (options.pending ?? []).length === 0) {
					continue;
				}
				path.pop();
				return componentDiagnostic(
					"component-dependency-missing",
					`component "${componentSourceLabel(current.ref)}" depends on "${componentSourceLabel(dependency)}", which is not present. The full closure must be admitted together.`,
					{ snapshotKey: key },
				);
			}
			const problem = walk(next, depth + 1);
			if (problem) {
				path.pop();
				return problem;
			}
		}
		path.pop();
		return null;
	};

	return walk(snapshot, 1);
}
