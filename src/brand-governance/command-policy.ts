/**
 * @file The command policy gateway (plan 0021 T-039, TD 0016 §15).
 *
 * ## One decision pipeline, consulted from one place
 *
 * Every mutation that can touch a governed instance asks the same question
 * through the same function. The alternative — each command checking policy its
 * own way — is how bypass paths appear: not by anyone disabling a check, but by
 * a new command simply never adding one. `validateBrandComponentCommand` is
 * therefore the whole decision, and commands call it rather than reimplement
 * it.
 *
 * ## The OD-08 intersection rule
 *
 * An instance can be nested: a page-level instance of A, whose Source contains
 * an instance of B. Both A's and B's policies apply, and **an edit is permitted
 * only if every policy on the path permits it**. Concretely, any
 * `lockStructure: true` or `allowDetach: false` anywhere on the path wins,
 * regardless of what a policy nearer the leaf says.
 *
 * The direction matters and is easy to get backwards: a *more deeply nested*
 * component cannot re-permit what an outer one forbade, because the outer
 * component is the thing the user actually placed and the inner one is an
 * implementation detail of it. Re-permitting would let an author escape a
 * brand restriction by wrapping the restricted component in a permissive one.
 *
 * ## Enforcement mode decides blocking, the component only recommends
 *
 * A policy's `recommendedEnforcement: "blocking"` blocks **only** when the host
 * context is also `blocking` (OD-10). A component cannot escalate itself into
 * blocking a host that is running advisory — that would let a third-party
 * library halt edits in a document its author does not own.
 */

import { CanvasCommandError } from "../commands/runtime.js";
import type { CanvasBrandComponentPolicy } from "../ir/component-policy.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasIR,
	CanvasNode,
} from "../ir/types.js";
import { walkDocument } from "../ir/walkers.js";
import type {
	CanvasPolicyDecision,
	CanvasPolicyEvaluator,
	CanvasPolicyOperation,
	CanvasPolicyQuery,
} from "../policy-contracts.js";
import type { CanvasBrandPolicyContext } from "./types.js";

/** Resolve the definition an instance points at, local or external. */
function definitionFor(
	ir: CanvasIR,
	instance: CanvasComponentInstanceNode,
): CanvasComponentDefinition | undefined {
	if (instance.source.kind === "local") {
		return ir.components?.[instance.source.componentId];
	}
	for (const snapshot of Object.values(ir.externalComponentSnapshots ?? {})) {
		const ref = snapshot.ref;
		if (
			ref.libraryId === instance.source.libraryId &&
			ref.componentId === instance.source.componentId &&
			ref.version === instance.source.version &&
			ref.integrity === instance.source.integrity
		) {
			return snapshot.definition;
		}
	}
	return undefined;
}

/**
 * Every policy on the path from the page-level instance inward.
 *
 * Ordered outermost-first. Bounded by `maxDepth` because a malformed document
 * can contain a reference cycle and this runs inside synchronous command
 * application.
 */
export function collectPolicyPath(
	ir: CanvasIR,
	instanceId: string,
	maxDepth = 32,
): readonly CanvasBrandComponentPolicy[] {
	let instance: CanvasComponentInstanceNode | undefined;
	walkDocument(ir, ({ node }) => {
		if (node.type === "component-instance" && node.id === instanceId) {
			instance = node;
		}
	});
	if (!instance) return [];

	const path: CanvasBrandComponentPolicy[] = [];
	const seen = new Set<string>();
	let current: CanvasComponentInstanceNode | undefined = instance;
	let depth = 0;

	while (current && depth < maxDepth) {
		const definition = definitionFor(ir, current);
		if (!definition) break;
		if (definition.policy) path.push(definition.policy);

		// Descend into the first nested instance, if any — that is the next link
		// in the containment chain whose policy also applies.
		const key = definition.id;
		if (seen.has(key)) break;
		seen.add(key);

		let nested: CanvasComponentInstanceNode | undefined;
		const stack: CanvasNode[] = [definition.root];
		while (stack.length > 0 && !nested) {
			const node = stack.pop() as CanvasNode;
			if (node.type === "component-instance") {
				nested = node;
				break;
			}
			const children = (node as { children?: readonly CanvasNode[] }).children;
			if (children) stack.push(...children);
		}
		current = nested;
		depth += 1;
	}
	return path;
}

/** Does every policy on the path permit this boolean capability? */
function pathPermits(
	path: readonly CanvasBrandComponentPolicy[],
	pick: (policy: CanvasBrandComponentPolicy) => boolean | undefined,
	defaultValue: boolean,
): boolean {
	// `every` over the path IS the intersection rule: one `false` anywhere wins.
	return path.every((policy) => pick(policy) ?? defaultValue);
}

/**
 * Does any policy on the path recommend blocking?
 *
 * Exported rather than used here: severity is decided by `effectiveSeverity` in
 * the compliance scanner (T-042), and this is the path-level input it needs.
 * The gateway itself never reads it — a component's recommendation cannot
 * change whether a COMMAND is refused, only how an ISSUE is reported.
 */
export function pathRecommendsBlocking(
	path: readonly CanvasBrandComponentPolicy[],
): boolean {
	return path.some((policy) => policy.recommendedEnforcement === "blocking");
}

export interface ValidateBrandComponentCommandInput {
	readonly ir: CanvasIR;
	readonly query: CanvasPolicyQuery;
	readonly context: CanvasBrandPolicyContext;
}

/**
 * The whole §15 pipeline: capability -> path policies -> intersection ->
 * enforcement mode.
 *
 * Pure and synchronous. Returns a decision; it never mutates and never throws.
 * `assertBrandComponentCommand` is what turns a `deny` into a thrown
 * `CanvasCommandError`, so a caller that wants to *report* rather than *block*
 * can use the same evaluation.
 */
export function validateBrandComponentCommand({
	ir,
	query,
	context,
}: ValidateBrandComponentCommandInput): CanvasPolicyDecision {
	if (context.enforcement === "off") return { outcome: "allow" };

	const caps = context.capabilities;
	const deny = (
		reason: CanvasPolicyDecision["reason"],
		detail: string,
	): CanvasPolicyDecision => ({
		// In advisory mode a violation is reported, never blocked (OD-10).
		outcome: context.enforcement === "blocking" ? "deny" : "warn",
		reason,
		detail,
		...(query.instanceId !== undefined ? { instanceId: query.instanceId } : {}),
		...(query.propertyId !== undefined ? { propertyId: query.propertyId } : {}),
	});

	// 1. Host capability — checked FIRST and independently of any policy, so a
	//    document with no policies at all still honours the host's own limits.
	const capabilityDenied: Partial<Record<CanvasPolicyOperation, boolean>> = {
		"override-set": !caps.canEditOverrides,
		"override-reset": !caps.canEditOverrides,
		"variant-change": !caps.canChangeVariant,
		detach: !caps.canDetach,
		flatten: !caps.canFlatten,
		"insert-external": !caps.canInsertExternalComponents,
		"source-update": !caps.canUpdateComponents,
		"source-swap": !caps.canUpdateComponents,
	};
	if (capabilityDenied[query.operation]) {
		return deny(
			"capability-denied",
			`This session may not perform "${query.operation}".`,
		);
	}

	// 2. Per-instance capability narrowing (OD-08), keyed by page-level id.
	if (
		query.instanceId !== undefined &&
		query.propertyId !== undefined &&
		(query.operation === "override-set" || query.operation === "override-reset")
	) {
		const allow = caps.editablePropertyIdsByInstance?.[query.instanceId];
		if (allow !== undefined && !allow.includes(query.propertyId)) {
			return deny(
				"property-not-editable",
				`Property "${query.propertyId}" is not editable on instance "${query.instanceId}" in this session.`,
			);
		}
	}

	if (query.instanceId === undefined) return { outcome: "allow" };
	const path = collectPolicyPath(ir, query.instanceId);
	if (path.length === 0) return { outcome: "allow" };

	// 3. Intersection over the whole path.
	switch (query.operation) {
		case "structure-edit":
			if (!pathPermits(path, (p) => !p.lockStructure, true)) {
				return deny(
					"structure-locked",
					"A component on this instance's path locks its structure.",
				);
			}
			break;
		case "detach":
			if (!pathPermits(path, (p) => p.allowDetach, true)) {
				return deny(
					"detach-denied",
					"A component on this instance's path forbids detaching.",
				);
			}
			break;
		case "flatten":
			if (!pathPermits(path, (p) => p.allowFlatten, true)) {
				return deny(
					"flatten-denied",
					"A component on this instance's path forbids flattening.",
				);
			}
			break;
		case "variant-change":
			if (!pathPermits(path, (p) => p.allowVariantChange, true)) {
				return deny(
					"variant-change-denied",
					"A component on this instance's path forbids changing variants.",
				);
			}
			break;
		case "source-update":
			if (!pathPermits(path, (p) => p.allowSourceUpdate, true)) {
				return deny(
					"source-update-denied",
					"A component on this instance's path pins its version.",
				);
			}
			break;
		case "source-swap":
			if (!pathPermits(path, (p) => p.allowSourceSwap, true)) {
				return deny(
					"source-swap-denied",
					"A component on this instance's path forbids replacing it with a different component.",
				);
			}
			break;
		case "override-set":
		case "override-reset": {
			if (query.propertyId === undefined) break;
			const editable = path.every(
				(policy) =>
					policy.editablePropertyIds === undefined ||
					policy.editablePropertyIds.includes(query.propertyId as string),
			);
			if (!editable) {
				return deny(
					"property-not-editable",
					`Property "${query.propertyId}" is not editable under this component's policy.`,
				);
			}
			break;
		}
		default:
			break;
	}

	// Reaching here means the operation is permitted by every policy on the
	// path. Enforcement mode was already applied inside `deny()`: a violation
	// becomes `deny` only under `blocking` and `warn` under `warning`, which is
	// how a component's `recommendedEnforcement` can never escalate a host that
	// is running advisory (OD-10).
	return { outcome: "allow" };
}

/**
 * Throwing wrapper for the mutation path.
 *
 * `deny` throws **before** any mutation, so a refused command leaves the
 * document untouched; `warn` returns the decision for the caller to report.
 */
export function assertBrandComponentCommand(
	input: ValidateBrandComponentCommandInput,
): CanvasPolicyDecision {
	const decision = validateBrandComponentCommand(input);
	if (decision.outcome === "deny") {
		throw new CanvasCommandError(
			"brand-policy-denied",
			`${decision.reason}: ${decision.detail ?? "denied by brand policy"}`,
		);
	}
	return decision;
}

/**
 * The evaluator form, for `CommandApplyOptions.brandPolicy`.
 *
 * Binds a document so the port's `(query, context)` signature — which cannot
 * mention `CanvasIR` without dragging brand vocabulary to rank 2 — can be
 * satisfied.
 */
export function createBrandPolicyEvaluator(
	ir: CanvasIR,
): CanvasPolicyEvaluator {
	return (query, context) =>
		validateBrandComponentCommand({
			ir,
			query,
			context: context as CanvasBrandPolicyContext,
		});
}
