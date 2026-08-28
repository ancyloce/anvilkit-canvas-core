/**
 * Iterative, document-wide admission budget (PLAN 0039 E1).
 *
 * This module deliberately accepts `unknown`: callers run it before Zod,
 * migrations, component expansion, layout, or rendering. Tree and dependency
 * traversal use explicit stacks/queues, so a hostile payload cannot consume
 * the JavaScript call stack. Counts saturate at limit + 1 after a violation;
 * exact values above a configured ceiling are unnecessary to make a safe
 * admission decision and would let an attacker choose the amount of work.
 */

import {
	MAX_CHILDREN_PER_CONTAINER,
	MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
	MAX_DOCUMENT_ASSETS,
	MAX_DOCUMENT_BYTES,
	MAX_DOCUMENT_COMPONENTS,
	MAX_DOCUMENT_NODES,
	MAX_DOCUMENT_PAGES,
	MAX_DOCUMENT_STRING_CHARACTERS,
	MAX_TREE_DEPTH,
} from "../limits.js";
import { snapshotKey } from "./snapshot-key.js";
import type { CanvasExternalComponentRef } from "./types.js";

export interface CanvasDocumentBudgetPolicy {
	readonly maxUtf8Bytes: number;
	readonly maxPages: number;
	readonly maxNodes: number;
	readonly maxTreeDepth: number;
	readonly maxChildrenPerContainer: number;
	readonly maxAssets: number;
	readonly maxComponents: number;
	readonly maxStringCharacters: number;
	readonly maxExpandedComponentNodes: number;
}

export const DEFAULT_CANVAS_DOCUMENT_BUDGET_POLICY: Readonly<CanvasDocumentBudgetPolicy> =
	Object.freeze({
		maxUtf8Bytes: MAX_DOCUMENT_BYTES,
		maxPages: MAX_DOCUMENT_PAGES,
		maxNodes: MAX_DOCUMENT_NODES,
		maxTreeDepth: MAX_TREE_DEPTH,
		maxChildrenPerContainer: MAX_CHILDREN_PER_CONTAINER,
		maxAssets: MAX_DOCUMENT_ASSETS,
		maxComponents: MAX_DOCUMENT_COMPONENTS,
		maxStringCharacters: MAX_DOCUMENT_STRING_CHARACTERS,
		maxExpandedComponentNodes: MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
	});

export type CanvasDocumentBudgetCode =
	| "document-assets-exceeded"
	| "document-bytes-exceeded"
	| "document-children-exceeded"
	| "document-component-cycle"
	| "document-components-exceeded"
	| "document-depth-exceeded"
	| "document-expanded-nodes-exceeded"
	| "document-json-invalid"
	| "document-nodes-exceeded"
	| "document-pages-exceeded"
	| "document-strings-exceeded";

export type CanvasDocumentBudgetRecoveryActionCode =
	| "break-component-cycle"
	| "flatten-tree"
	| "remove-assets"
	| "remove-components"
	| "remove-nodes"
	| "remove-pages"
	| "reduce-component-expansion"
	| "reduce-document-size"
	| "shorten-text"
	| "split-container"
	| "split-document"
	| "use-json-compatible-values";

export interface CanvasDocumentBudgetRecoveryAction {
	/** Stable machine-readable action code. */
	readonly code: CanvasDocumentBudgetRecoveryActionCode;
	/** Short human-readable remediation guidance. */
	readonly label: string;
}

export interface CanvasDocumentBudgetIssue {
	readonly code: CanvasDocumentBudgetCode;
	readonly observed: number;
	readonly limit: number;
	readonly path: string;
	readonly message: string;
	readonly recoveryActions: readonly CanvasDocumentBudgetRecoveryAction[];
}

export interface CanvasDocumentBudgetMetrics {
	readonly utf8Bytes: number;
	readonly pages: number;
	readonly nodes: number;
	readonly maxTreeDepth: number;
	readonly maxChildrenPerContainer: number;
	readonly assets: number;
	readonly components: number;
	readonly stringCharacters: number;
	readonly expandedComponentNodes: number;
}

export interface CanvasDocumentBudgetResult {
	readonly ok: boolean;
	readonly metrics: CanvasDocumentBudgetMetrics;
	readonly issues: readonly CanvasDocumentBudgetIssue[];
}

export interface ValidateCanvasDocumentBudgetOptions {
	/** Override individual ceilings without replacing the default policy. */
	readonly policy?: Partial<CanvasDocumentBudgetPolicy>;
	/**
	 * Exact transport byte length when the caller still has the source bytes.
	 * When omitted, the validator measures the compact JSON representation.
	 */
	readonly rawByteLength?: number;
}

type UnknownRecord = Record<string, unknown>;

interface JsonMeasurement {
	readonly utf8Bytes: number;
	readonly stringCharacters: number;
	readonly jsonCompatible: boolean;
}

interface TreeInspection {
	readonly nodes: number;
	readonly maxDepth: number;
	readonly maxDepthPath: string;
	readonly maxChildren: number;
	readonly maxChildrenPath: string;
	readonly componentRefs: readonly string[];
}

interface DefinitionInspection {
	readonly path: string;
	readonly ownNodes: number;
	readonly refs: readonly string[];
}

const encoder = new TextEncoder();
const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const recoveryActionsByCode: Readonly<
	Record<
		CanvasDocumentBudgetCode,
		readonly CanvasDocumentBudgetRecoveryAction[]
	>
> = {
	"document-assets-exceeded": [
		{ code: "remove-assets", label: "Remove unused assets." },
	],
	"document-bytes-exceeded": [
		{
			code: "reduce-document-size",
			label: "Reduce the serialized document size.",
		},
		{ code: "split-document", label: "Split the content into documents." },
	],
	"document-children-exceeded": [
		{
			code: "split-container",
			label: "Split this container into smaller containers.",
		},
	],
	"document-component-cycle": [
		{
			code: "break-component-cycle",
			label: "Remove the recursive component reference.",
		},
	],
	"document-components-exceeded": [
		{
			code: "remove-components",
			label: "Remove unused component definitions or snapshots.",
		},
	],
	"document-depth-exceeded": [
		{ code: "flatten-tree", label: "Flatten deeply nested containers." },
	],
	"document-expanded-nodes-exceeded": [
		{
			code: "reduce-component-expansion",
			label: "Reduce nested component instances or simplify definitions.",
		},
	],
	"document-json-invalid": [
		{
			code: "use-json-compatible-values",
			label: "Remove cycles and values that JSON cannot represent.",
		},
	],
	"document-nodes-exceeded": [
		{ code: "remove-nodes", label: "Remove unnecessary canvas nodes." },
		{ code: "split-document", label: "Split the content into documents." },
	],
	"document-pages-exceeded": [
		{ code: "remove-pages", label: "Remove unnecessary pages." },
		{ code: "split-document", label: "Split the content into documents." },
	],
	"document-strings-exceeded": [
		{ code: "shorten-text", label: "Shorten text and metadata values." },
	],
};

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function propertyPath(base: string, key: string): string {
	return identifierPattern.test(key)
		? `${base}.${key}`
		: `${base}[${JSON.stringify(key)}]`;
}

function cappedAdd(current: number, amount: number, limit: number): number {
	if (current > limit || amount > limit - current) return limit + 1;
	return current + amount;
}

function utf8Length(value: string): number {
	return encoder.encode(value).byteLength;
}

function quotedUtf8Length(value: string): number {
	return utf8Length(JSON.stringify(value));
}

function isJsonOmitted(value: unknown): boolean {
	return (
		value === undefined ||
		typeof value === "function" ||
		typeof value === "symbol"
	);
}

type JsonTask =
	| {
			readonly kind: "value";
			readonly value: unknown;
			readonly arraySlot: boolean;
	  }
	| { readonly kind: "leave"; readonly value: object };

/** Measure compact JSON without calling recursive `JSON.stringify` on objects. */
function measureJson(
	value: unknown,
	policy: CanvasDocumentBudgetPolicy,
): JsonMeasurement {
	let utf8Bytes = 0;
	let stringCharacters = 0;
	let jsonCompatible = true;
	const active = new WeakSet<object>();
	const stack: JsonTask[] = [{ kind: "value", value, arraySlot: false }];

	const addBytes = (amount: number) => {
		utf8Bytes = cappedAdd(utf8Bytes, amount, policy.maxUtf8Bytes);
	};
	const addCharacters = (amount: number) => {
		stringCharacters = cappedAdd(
			stringCharacters,
			amount,
			policy.maxStringCharacters,
		);
	};

	while (stack.length > 0) {
		const task = stack.pop();
		if (!task) continue;
		if (task.kind === "leave") {
			active.delete(task.value);
			continue;
		}

		const current = task.value;
		if (current === null) {
			addBytes(4);
			continue;
		}
		switch (typeof current) {
			case "string":
				addCharacters(current.length);
				addBytes(quotedUtf8Length(current));
				continue;
			case "number":
				addBytes(utf8Length(JSON.stringify(current)));
				continue;
			case "boolean":
				addBytes(current ? 4 : 5);
				continue;
			case "undefined":
			case "function":
			case "symbol":
				if (task.arraySlot) addBytes(4);
				else jsonCompatible = false;
				continue;
			case "bigint":
				jsonCompatible = false;
				continue;
			case "object":
				break;
		}

		if (active.has(current)) {
			jsonCompatible = false;
			continue;
		}
		active.add(current);
		stack.push({ kind: "leave", value: current });

		if (Array.isArray(current)) {
			addBytes(2 + Math.max(0, current.length - 1));
			// Every array slot costs at least four bytes (`null`) plus separators.
			// Once that lower bound exceeds the byte ceiling, the document is
			// already rejected and walking the sparse tail would only add work.
			if (current.length > Math.floor(policy.maxUtf8Bytes / 2) + 1) {
				utf8Bytes = policy.maxUtf8Bytes + 1;
				continue;
			}
			for (let index = current.length - 1; index >= 0; index -= 1) {
				stack.push({
					kind: "value",
					value: current[index],
					arraySlot: true,
				});
			}
			continue;
		}

		const entries: [string, unknown][] = [];
		try {
			for (const key of Object.keys(current)) {
				const entryValue = (current as UnknownRecord)[key];
				if (!isJsonOmitted(entryValue)) entries.push([key, entryValue]);
			}
		} catch {
			jsonCompatible = false;
			continue;
		}
		addBytes(2 + Math.max(0, entries.length - 1));
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			const entry = entries[index];
			if (!entry) continue;
			const [key, entryValue] = entry;
			addCharacters(key.length);
			addBytes(quotedUtf8Length(key) + 1);
			stack.push({ kind: "value", value: entryValue, arraySlot: false });
		}
	}

	return { utf8Bytes, stringCharacters, jsonCompatible };
}

function sourceKeyOf(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "local" && typeof value.componentId === "string") {
		return `local:${value.componentId}`;
	}
	if (value.kind !== "external") return undefined;
	try {
		return `external:${snapshotKey(value as unknown as CanvasExternalComponentRef)}`;
	} catch {
		return undefined;
	}
}

function inspectTree(
	root: unknown,
	rootPath: string,
	policy: CanvasDocumentBudgetPolicy,
): TreeInspection {
	let nodes = 0;
	let maxDepth = 0;
	let maxDepthPath = rootPath;
	let maxChildren = 0;
	let maxChildrenPath = rootPath;
	const componentRefs: string[] = [];
	const visited = new WeakSet<object>();
	const stack: { value: unknown; depth: number; path: string }[] = [
		{ value: root, depth: 0, path: rootPath },
	];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || !isRecord(current.value)) continue;
		if (visited.has(current.value)) continue;
		visited.add(current.value);
		nodes = cappedAdd(nodes, 1, policy.maxNodes);
		if (current.depth > maxDepth) {
			maxDepth = current.depth;
			maxDepthPath = current.path;
		}
		if (current.value.type === "component-instance") {
			const ref = sourceKeyOf(current.value.source);
			if (ref) componentRefs.push(ref);
		}

		const children = current.value.children;
		if (!Array.isArray(children)) continue;
		if (children.length > maxChildren) {
			maxChildren = children.length;
			maxChildrenPath = `${current.path}.children`;
		}
		if (children.length === 0) continue;
		if (current.depth >= policy.maxTreeDepth) {
			maxDepth = Math.max(maxDepth, current.depth + 1);
			maxDepthPath = `${current.path}.children[0]`;
			continue;
		}

		const remainingNodeCapacity = Math.max(0, policy.maxNodes + 1 - nodes);
		const inspectedChildren = Math.min(children.length, remainingNodeCapacity);
		for (let index = inspectedChildren - 1; index >= 0; index -= 1) {
			stack.push({
				value: children[index],
				depth: current.depth + 1,
				path: `${current.path}.children[${index}]`,
			});
		}
		if (children.length > inspectedChildren) {
			nodes = policy.maxNodes + 1;
		}
	}

	return {
		nodes,
		maxDepth,
		maxDepthPath,
		maxChildren,
		maxChildrenPath,
		componentRefs,
	};
}

function entriesOf(value: unknown): readonly [string, unknown][] {
	return isRecord(value) ? Object.entries(value) : [];
}

function pageRootsOf(value: unknown): readonly [unknown, string][] {
	if (!isRecord(value) || !Array.isArray(value.pages)) return [];
	const roots: [unknown, string][] = [];
	for (let index = 0; index < value.pages.length; index += 1) {
		const page = value.pages[index];
		roots.push([
			isRecord(page) ? page.root : undefined,
			`$.pages[${index}].root`,
		]);
	}
	return roots;
}

function inspectDefinitions(
	value: unknown,
	policy: CanvasDocumentBudgetPolicy,
): ReadonlyMap<string, DefinitionInspection> {
	const definitions = new Map<string, DefinitionInspection>();
	if (!isRecord(value)) return definitions;

	for (const [id, definitionValue] of entriesOf(value.components)) {
		const definition = isRecord(definitionValue) ? definitionValue : undefined;
		const path = `${propertyPath("$.components", id)}.root`;
		const inspection = inspectTree(definition?.root, path, policy);
		definitions.set(`local:${id}`, {
			path,
			ownNodes: inspection.nodes,
			refs: inspection.componentRefs,
		});
	}

	for (const [key, snapshotValue] of entriesOf(
		value.externalComponentSnapshots,
	)) {
		const snapshot = isRecord(snapshotValue) ? snapshotValue : undefined;
		const definition = isRecord(snapshot?.definition)
			? snapshot.definition
			: undefined;
		const path = `${propertyPath("$.externalComponentSnapshots", key)}.definition.root`;
		const inspection = inspectTree(definition?.root, path, policy);
		const refKey = sourceKeyOf(snapshot?.ref);
		if (!refKey) continue;
		definitions.set(refKey, {
			path,
			ownNodes: inspection.nodes,
			refs: inspection.componentRefs,
		});
	}

	return definitions;
}

function calculateExpandedNodes(
	definitions: ReadonlyMap<string, DefinitionInspection>,
	pageRefs: readonly string[],
	limit: number,
): { expandedNodes: number; cycle?: DefinitionInspection } {
	const remaining = new Map<string, Set<string>>();
	const dependents = new Map<string, Set<string>>();
	const expandedSizes = new Map<string, number>();
	const queue: string[] = [];

	for (const [key, definition] of definitions) {
		const dependencies = new Set(
			definition.refs.filter((ref) => definitions.has(ref)),
		);
		remaining.set(key, dependencies);
		if (dependencies.size === 0) queue.push(key);
		for (const dependency of dependencies) {
			const parents = dependents.get(dependency) ?? new Set<string>();
			parents.add(key);
			dependents.set(dependency, parents);
		}
	}

	for (let cursor = 0; cursor < queue.length; cursor += 1) {
		const key = queue[cursor];
		if (!key) continue;
		const definition = definitions.get(key);
		if (!definition) continue;
		let size = Math.min(definition.ownNodes, limit + 1);
		for (const ref of definition.refs) {
			size = cappedAdd(size, expandedSizes.get(ref) ?? 0, limit);
		}
		expandedSizes.set(key, size);
		for (const parent of dependents.get(key) ?? []) {
			const unresolved = remaining.get(parent);
			if (!unresolved) continue;
			unresolved.delete(key);
			if (unresolved.size === 0) queue.push(parent);
		}
	}

	for (const [key, unresolved] of remaining) {
		if (unresolved.size > 0) {
			return {
				expandedNodes: limit + 1,
				cycle: definitions.get(key),
			};
		}
	}

	let expandedNodes = 0;
	for (const ref of pageRefs) {
		expandedNodes = cappedAdd(
			expandedNodes,
			expandedSizes.get(ref) ?? 0,
			limit,
		);
	}
	return { expandedNodes };
}

function metricIssue(
	code: CanvasDocumentBudgetCode,
	label: string,
	observed: number,
	limit: number,
	path: string,
): CanvasDocumentBudgetIssue {
	return {
		code,
		observed,
		limit,
		path,
		message: `${label} is ${observed.toLocaleString()} (maximum ${limit.toLocaleString()}) at ${path}.`,
		recoveryActions: recoveryActionsByCode[code],
	};
}

function resolvePolicy(
	overrides: Partial<CanvasDocumentBudgetPolicy> | undefined,
): CanvasDocumentBudgetPolicy {
	const policy = { ...DEFAULT_CANVAS_DOCUMENT_BUDGET_POLICY, ...overrides };
	for (const [name, value] of Object.entries(policy)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new TypeError(
				`Canvas document budget ${name} must be a non-negative safe integer.`,
			);
		}
	}
	return policy;
}

/**
 * Inspect an untrusted CanvasIR candidate before schema parsing or migration.
 */
export function validateCanvasDocumentBudget(
	value: unknown,
	options: ValidateCanvasDocumentBudgetOptions = {},
): CanvasDocumentBudgetResult {
	const policy = resolvePolicy(options.policy);
	if (
		options.rawByteLength !== undefined &&
		(!Number.isSafeInteger(options.rawByteLength) || options.rawByteLength < 0)
	) {
		throw new TypeError("rawByteLength must be a non-negative safe integer.");
	}

	const measurement = measureJson(value, policy);
	const utf8Bytes = options.rawByteLength ?? measurement.utf8Bytes;
	const pages =
		isRecord(value) && Array.isArray(value.pages) ? value.pages.length : 0;
	const assets = entriesOf(isRecord(value) ? value.assets : undefined).length;
	const localComponents = entriesOf(
		isRecord(value) ? value.components : undefined,
	).length;
	const externalComponents = entriesOf(
		isRecord(value) ? value.externalComponentSnapshots : undefined,
	).length;
	const components = localComponents + externalComponents;

	let nodes = 0;
	let maxTreeDepth = 0;
	let maxTreeDepthPath = "$.pages";
	let maxChildrenPerContainer = 0;
	let maxChildrenPath = "$.pages";
	const pageRefs: string[] = [];
	const roots = pageRootsOf(value);
	const definitions = inspectDefinitions(value, policy);
	const definitionRoots = [...definitions.values()];
	for (const [root, path] of roots) {
		const inspection = inspectTree(root, path, policy);
		nodes = cappedAdd(nodes, inspection.nodes, policy.maxNodes);
		pageRefs.push(...inspection.componentRefs);
		if (inspection.maxDepth > maxTreeDepth) {
			maxTreeDepth = inspection.maxDepth;
			maxTreeDepthPath = inspection.maxDepthPath;
		}
		if (inspection.maxChildren > maxChildrenPerContainer) {
			maxChildrenPerContainer = inspection.maxChildren;
			maxChildrenPath = inspection.maxChildrenPath;
		}
	}
	for (const definition of definitionRoots) {
		nodes = cappedAdd(nodes, definition.ownNodes, policy.maxNodes);
		const inspection = inspectTree(
			isRecord(value) ? undefined : undefined,
			definition.path,
			policy,
		);
		// Definition depth/width were already inspected while building the graph.
		// They are re-read below from the raw roots to keep their maxima available
		// without retaining every traversed node.
		void inspection;
	}

	// Include local and external Source depth/width in the document maxima.
	if (isRecord(value)) {
		const sourceRoots: [unknown, string][] = [];
		for (const [id, rawDefinition] of entriesOf(value.components)) {
			const definition = isRecord(rawDefinition) ? rawDefinition : undefined;
			sourceRoots.push([
				definition?.root,
				`${propertyPath("$.components", id)}.root`,
			]);
		}
		for (const [key, rawSnapshot] of entriesOf(
			value.externalComponentSnapshots,
		)) {
			const snapshot = isRecord(rawSnapshot) ? rawSnapshot : undefined;
			const definition = isRecord(snapshot?.definition)
				? snapshot.definition
				: undefined;
			sourceRoots.push([
				definition?.root,
				`${propertyPath("$.externalComponentSnapshots", key)}.definition.root`,
			]);
		}
		for (const [root, path] of sourceRoots) {
			const inspection = inspectTree(root, path, policy);
			if (inspection.maxDepth > maxTreeDepth) {
				maxTreeDepth = inspection.maxDepth;
				maxTreeDepthPath = inspection.maxDepthPath;
			}
			if (inspection.maxChildren > maxChildrenPerContainer) {
				maxChildrenPerContainer = inspection.maxChildren;
				maxChildrenPath = inspection.maxChildrenPath;
			}
		}
	}

	const expansion = calculateExpandedNodes(
		definitions,
		pageRefs,
		policy.maxExpandedComponentNodes,
	);
	const metrics: CanvasDocumentBudgetMetrics = {
		utf8Bytes,
		pages,
		nodes,
		maxTreeDepth,
		maxChildrenPerContainer,
		assets,
		components,
		stringCharacters: measurement.stringCharacters,
		expandedComponentNodes: expansion.expandedNodes,
	};
	const issues: CanvasDocumentBudgetIssue[] = [];

	if (!measurement.jsonCompatible) {
		issues.push(
			metricIssue(
				"document-json-invalid",
				"Document JSON compatibility flag",
				1,
				0,
				"$",
			),
		);
	}
	if (utf8Bytes > policy.maxUtf8Bytes) {
		issues.push(
			metricIssue(
				"document-bytes-exceeded",
				"Document UTF-8 byte size",
				utf8Bytes,
				policy.maxUtf8Bytes,
				"$",
			),
		);
	}
	if (pages > policy.maxPages) {
		issues.push(
			metricIssue(
				"document-pages-exceeded",
				"Document page count",
				pages,
				policy.maxPages,
				"$.pages",
			),
		);
	}
	if (nodes > policy.maxNodes) {
		issues.push(
			metricIssue(
				"document-nodes-exceeded",
				"Document node count",
				nodes,
				policy.maxNodes,
				"$",
			),
		);
	}
	if (maxTreeDepth > policy.maxTreeDepth) {
		issues.push(
			metricIssue(
				"document-depth-exceeded",
				"Document tree depth",
				maxTreeDepth,
				policy.maxTreeDepth,
				maxTreeDepthPath,
			),
		);
	}
	if (maxChildrenPerContainer > policy.maxChildrenPerContainer) {
		issues.push(
			metricIssue(
				"document-children-exceeded",
				"Container child count",
				maxChildrenPerContainer,
				policy.maxChildrenPerContainer,
				maxChildrenPath,
			),
		);
	}
	if (assets > policy.maxAssets) {
		issues.push(
			metricIssue(
				"document-assets-exceeded",
				"Document asset count",
				assets,
				policy.maxAssets,
				"$.assets",
			),
		);
	}
	if (components > policy.maxComponents) {
		issues.push(
			metricIssue(
				"document-components-exceeded",
				"Document component count",
				components,
				policy.maxComponents,
				"$",
			),
		);
	}
	if (measurement.stringCharacters > policy.maxStringCharacters) {
		issues.push(
			metricIssue(
				"document-strings-exceeded",
				"Document string character count",
				measurement.stringCharacters,
				policy.maxStringCharacters,
				"$",
			),
		);
	}
	if (expansion.cycle) {
		issues.push(
			metricIssue(
				"document-component-cycle",
				"Recursive component dependency count",
				1,
				0,
				expansion.cycle.path,
			),
		);
	}
	if (expansion.expandedNodes > policy.maxExpandedComponentNodes) {
		issues.push(
			metricIssue(
				"document-expanded-nodes-exceeded",
				"Expanded component node count",
				expansion.expandedNodes,
				policy.maxExpandedComponentNodes,
				"$.pages",
			),
		);
	}

	return { ok: issues.length === 0, metrics, issues };
}

export class CanvasDocumentBudgetError extends Error {
	readonly result: CanvasDocumentBudgetResult;
	readonly issues: readonly CanvasDocumentBudgetIssue[];
	readonly metrics: CanvasDocumentBudgetMetrics;

	constructor(result: CanvasDocumentBudgetResult) {
		const primary = result.issues[0];
		const firstAction = primary?.recoveryActions[0];
		const additionalIssueCount = Math.max(0, result.issues.length - 1);
		super(
			primary
				? `Canvas document rejected: ${primary.message}${firstAction ? ` ${firstAction.label}` : ""}${additionalIssueCount > 0 ? ` (${additionalIssueCount} additional budget issue${additionalIssueCount === 1 ? "" : "s"}.)` : ""}`
				: "Canvas document rejected by its admission budget.",
		);
		this.name = "CanvasDocumentBudgetError";
		this.result = result;
		this.issues = result.issues;
		this.metrics = result.metrics;
	}
}

/** Throwing form for load boundaries that cannot proceed after rejection. */
export function assertCanvasDocumentBudget(
	value: unknown,
	options: ValidateCanvasDocumentBudgetOptions = {},
): CanvasDocumentBudgetMetrics {
	const result = validateCanvasDocumentBudget(value, options);
	if (!result.ok) throw new CanvasDocumentBudgetError(result);
	return result.metrics;
}
