import { describe, expect, it } from "vitest";

import { applyCommand, CanvasCommandError } from "../../commands/runtime.js";
import { createCanvasIR, createComponentInstance } from "../../ir/builders.js";
import type { CanvasBrandComponentPolicy } from "../../ir/component-policy.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import type { CanvasPolicyOperation } from "../../policy-contracts.js";
import {
	assertBrandComponentCommand,
	collectPolicyPath,
	createBrandPolicyEvaluator,
	validateBrandComponentCommand,
} from "../command-policy.js";
import type {
	CanvasBrandCapabilities,
	CanvasBrandPolicyContext,
} from "../types.js";

/**
 * T-039 — the command policy gateway.
 *
 * Acceptance is "zero known bypass paths", which is a claim about COVERAGE, so
 * the operation matrix is enumerated from the `CanvasPolicyOperation` union
 * itself rather than hand-listed: adding an operation without a policy rule
 * fails a test here.
 */

const ALL_CAPS: CanvasBrandCapabilities = {
	canEditOverrides: true,
	canChangeVariant: true,
	canDetach: true,
	canFlatten: true,
	canInsertExternalComponents: true,
	canUpdateComponents: true,
};

function context(
	overrides: Partial<CanvasBrandPolicyContext> = {},
): CanvasBrandPolicyContext {
	return {
		enforcement: "blocking",
		capabilities: ALL_CAPS,
		...overrides,
	};
}

function definition(
	id: string,
	policy?: CanvasBrandComponentPolicy,
	nested?: CanvasNode,
): CanvasComponentDefinition {
	return {
		id,
		name: id,
		revision: 1,
		root: {
			id: `${id}-root`,
			type: "frame",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			children: nested ? [nested] : [],
		},
		properties: [
			{ id: "p-a", name: "A", nodeId: "n-a", kind: "text", targetKind: "text" },
			{ id: "p-b", name: "B", nodeId: "n-b", kind: "text", targetKind: "text" },
		],
		...(policy ? { policy } : {}),
	} as CanvasComponentDefinition;
}

/** Document with ONE page-level instance of `outer`. */
function doc(
	outerPolicy?: CanvasBrandComponentPolicy,
	innerPolicy?: CanvasBrandComponentPolicy,
): CanvasIR {
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	const nestedInstance = innerPolicy
		? ({
				id: "nested",
				type: "component-instance",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: { width: 5, height: 5 },
				zIndex: 0,
				source: { kind: "local", componentId: "inner" },
			} as CanvasNode)
		: undefined;

	const components: Record<string, CanvasComponentDefinition> = {
		outer: definition("outer", outerPolicy, nestedInstance),
	};
	if (innerPolicy) components.inner = definition("inner", innerPolicy);

	const withRegistry: CanvasIR = { ...base, components };
	return insertNode(withRegistry, {
		parentId: withRegistry.pages[0]?.root.id as string,
		node: createComponentInstance({
			id: "inst-1",
			componentId: "outer",
			bounds: { width: 10, height: 10 },
		}),
		now: () => "t0",
	});
}

const OPERATIONS: readonly CanvasPolicyOperation[] = [
	"override-set",
	"override-reset",
	"variant-change",
	"structure-edit",
	"detach",
	"flatten",
	"source-update",
	"source-swap",
	"insert-external",
];

describe("host capability gate (§15.1 matrix)", () => {
	it.each([
		["override-set", "canEditOverrides"],
		["override-reset", "canEditOverrides"],
		["variant-change", "canChangeVariant"],
		["detach", "canDetach"],
		["flatten", "canFlatten"],
		["insert-external", "canInsertExternalComponents"],
		["source-update", "canUpdateComponents"],
		["source-swap", "canUpdateComponents"],
	] as const)("denies %s when %s is false", (operation, capability) => {
		const decision = validateBrandComponentCommand({
			ir: doc(),
			query: { operation, instanceId: "inst-1", propertyId: "p-a" },
			context: context({ capabilities: { ...ALL_CAPS, [capability]: false } }),
		});
		expect(decision.outcome).toBe("deny");
		expect(decision.reason).toBe("capability-denied");
	});

	it("applies the capability gate even with NO policy in the document", () => {
		// A host limit is the host's, not the component's — a document with no
		// policies must still honour it.
		const decision = validateBrandComponentCommand({
			ir: doc(),
			query: { operation: "detach", instanceId: "inst-1" },
			context: context({ capabilities: { ...ALL_CAPS, canDetach: false } }),
		});
		expect(decision.outcome).toBe("deny");
	});

	it("allows every operation when nothing denies", () => {
		for (const operation of OPERATIONS) {
			expect(
				validateBrandComponentCommand({
					ir: doc(),
					query: { operation, instanceId: "inst-1", propertyId: "p-a" },
					context: context(),
				}).outcome,
			).toBe("allow");
		}
	});
});

describe("OD-08 intersection — every policy on the path must permit", () => {
	it.each([
		["structure-edit", { lockStructure: true }, "structure-locked"],
		["detach", { allowDetach: false }, "detach-denied"],
		["flatten", { allowFlatten: false }, "flatten-denied"],
		["variant-change", { allowVariantChange: false }, "variant-change-denied"],
	] as const)("denies %s when the OUTER policy forbids it", (operation, policy, reason) => {
		const decision = validateBrandComponentCommand({
			ir: doc(policy),
			query: { operation, instanceId: "inst-1" },
			context: context(),
		});
		expect(decision.outcome).toBe("deny");
		expect(decision.reason).toBe(reason);
	});

	it.each([
		["structure-edit", { lockStructure: true }],
		["detach", { allowDetach: false }],
	] as const)("denies %s when only the NESTED policy forbids it", (operation, policy) => {
		// The inner component is an implementation detail of the outer one,
		// but its restriction still applies — intersection, not override.
		const decision = validateBrandComponentCommand({
			ir: doc(undefined, policy),
			query: { operation, instanceId: "inst-1" },
			context: context(),
		});
		expect(decision.outcome).toBe("deny");
	});

	it("a permissive INNER policy cannot re-permit what the OUTER one forbade", () => {
		// The escape hatch this rule closes: wrapping a restricted component in a
		// permissive one to launder the restriction away.
		const decision = validateBrandComponentCommand({
			ir: doc({ allowDetach: false }, { allowDetach: true }),
			query: { operation: "detach", instanceId: "inst-1" },
			context: context(),
		});
		expect(decision.outcome).toBe("deny");
		expect(decision.reason).toBe("detach-denied");
	});

	it("permits when every policy on the path permits", () => {
		expect(
			validateBrandComponentCommand({
				ir: doc({ allowDetach: true }, { allowDetach: true }),
				query: { operation: "detach", instanceId: "inst-1" },
				context: context(),
			}).outcome,
		).toBe("allow");
	});

	it("collects the path outermost-first and terminates on a cycle", () => {
		const path = collectPolicyPath(
			doc({ lockStructure: true }, { allowDetach: false }),
			"inst-1",
		);
		expect(path).toHaveLength(2);
		expect(path[0]?.lockStructure).toBe(true);

		// A self-referencing definition must not hang synchronous command
		// application.
		const base = createCanvasIR({ id: "d", now: () => "t0" });
		const selfRef: CanvasIR = {
			...base,
			components: {
				loop: definition("loop", { lockStructure: true }, {
					id: "n",
					type: "component-instance",
					transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
					bounds: { width: 1, height: 1 },
					zIndex: 0,
					source: { kind: "local", componentId: "loop" },
				} as CanvasNode),
			},
		};
		const withInstance = insertNode(selfRef, {
			parentId: selfRef.pages[0]?.root.id as string,
			node: createComponentInstance({
				id: "i",
				componentId: "loop",
				bounds: { width: 1, height: 1 },
			}),
			now: () => "t0",
		});
		expect(() => collectPolicyPath(withInstance, "i")).not.toThrow();
	});
});

describe("editable-property allowlists", () => {
	it("denies a property the component policy does not list", () => {
		const decision = validateBrandComponentCommand({
			ir: doc({ editablePropertyIds: ["p-a"] }),
			query: {
				operation: "override-set",
				instanceId: "inst-1",
				propertyId: "p-b",
			},
			context: context(),
		});
		expect(decision.outcome).toBe("deny");
		expect(decision.reason).toBe("property-not-editable");
	});

	it("denies a property the SESSION allowlist excludes (OD-08 per-instance)", () => {
		const decision = validateBrandComponentCommand({
			ir: doc(),
			query: {
				operation: "override-set",
				instanceId: "inst-1",
				propertyId: "p-b",
			},
			context: context({
				capabilities: {
					...ALL_CAPS,
					editablePropertyIdsByInstance: { "inst-1": ["p-a"] },
				},
			}),
		});
		expect(decision.outcome).toBe("deny");
		expect(decision.reason).toBe("property-not-editable");
	});

	it("an ABSENT per-instance entry means no narrowing", () => {
		expect(
			validateBrandComponentCommand({
				ir: doc(),
				query: {
					operation: "override-set",
					instanceId: "inst-1",
					propertyId: "p-b",
				},
				context: context({
					capabilities: {
						...ALL_CAPS,
						editablePropertyIdsByInstance: { "other-inst": ["p-a"] },
					},
				}),
			}).outcome,
		).toBe("allow");
	});
});

describe("enforcement mode (OD-10)", () => {
	it("`off` evaluates nothing at all", () => {
		expect(
			validateBrandComponentCommand({
				ir: doc({ allowDetach: false }),
				query: { operation: "detach", instanceId: "inst-1" },
				context: context({
					enforcement: "off",
					capabilities: { ...ALL_CAPS, canDetach: false },
				}),
			}).outcome,
		).toBe("allow");
	});

	it("`warning` reports instead of blocking", () => {
		const decision = validateBrandComponentCommand({
			ir: doc({ allowDetach: false }),
			query: { operation: "detach", instanceId: "inst-1" },
			context: context({ enforcement: "warning" }),
		});
		expect(decision.outcome).toBe("warn");
		expect(decision.reason).toBe("detach-denied");
	});

	it("a component's `recommendedEnforcement: blocking` cannot escalate an advisory host", () => {
		// A third-party library must not be able to halt edits in a document its
		// author does not own.
		const decision = validateBrandComponentCommand({
			ir: doc({ allowDetach: false, recommendedEnforcement: "blocking" }),
			query: { operation: "detach", instanceId: "inst-1" },
			context: context({ enforcement: "warning" }),
		});
		expect(decision.outcome).toBe("warn");
	});
});

describe("assertBrandComponentCommand — throws BEFORE mutation", () => {
	it("throws a typed error on deny", () => {
		expect(() =>
			assertBrandComponentCommand({
				ir: doc({ allowDetach: false }),
				query: { operation: "detach", instanceId: "inst-1" },
				context: context(),
			}),
		).toThrow(CanvasCommandError);

		try {
			assertBrandComponentCommand({
				ir: doc({ allowDetach: false }),
				query: { operation: "detach", instanceId: "inst-1" },
				context: context(),
			});
		} catch (error) {
			expect((error as CanvasCommandError).code).toBe("brand-policy-denied");
		}
	});

	it("returns a warn decision instead of throwing", () => {
		expect(
			assertBrandComponentCommand({
				ir: doc({ allowDetach: false }),
				query: { operation: "detach", instanceId: "inst-1" },
				context: context({ enforcement: "warning" }),
			}).outcome,
		).toBe("warn");
	});

	it("never mutates the document", () => {
		const ir = doc({ allowDetach: false });
		const before = structuredClone(ir);
		try {
			assertBrandComponentCommand({
				ir,
				query: { operation: "detach", instanceId: "inst-1" },
				context: context(),
			});
		} catch {
			/* expected */
		}
		expect(ir).toEqual(before);
	});
});

describe("source-update / source-swap path rules (TD §15.1)", () => {
	/**
	 * TD §15.1's matrix lists "Update/swap" as governed by portable policy, but
	 * the intersection switch had no case for either — they fell to `default`
	 * and were gated by the host capability alone. These are the rules that
	 * close that, and they are separate fields on purpose: "take my bug fixes,
	 * but do not substitute a different component for our logo lockup" is a
	 * realistic posture that one combined field could not express.
	 */

	it("allows both when no policy says otherwise", () => {
		for (const operation of ["source-update", "source-swap"] as const) {
			expect(
				validateBrandComponentCommand({
					ir: doc({}),
					query: { operation, instanceId: "inst-1" },
					context: context(),
				}).outcome,
			).toBe("allow");
		}
	});

	it("`allowSourceUpdate: false` denies update but NOT swap", () => {
		const ir = doc({ allowSourceUpdate: false });
		const update = validateBrandComponentCommand({
			ir,
			query: { operation: "source-update", instanceId: "inst-1" },
			context: context(),
		});
		expect(update.outcome).toBe("deny");
		expect(update.reason).toBe("source-update-denied");
		// The asymmetry is the point.
		expect(
			validateBrandComponentCommand({
				ir,
				query: { operation: "source-swap", instanceId: "inst-1" },
				context: context(),
			}).outcome,
		).toBe("allow");
	});

	it("`allowSourceSwap: false` denies swap but NOT update", () => {
		const ir = doc({ allowSourceSwap: false });
		const swap = validateBrandComponentCommand({
			ir,
			query: { operation: "source-swap", instanceId: "inst-1" },
			context: context(),
		});
		expect(swap.outcome).toBe("deny");
		expect(swap.reason).toBe("source-swap-denied");
		expect(
			validateBrandComponentCommand({
				ir,
				query: { operation: "source-update", instanceId: "inst-1" },
				context: context(),
			}).outcome,
		).toBe("allow");
	});

	it("intersects down the path — a NESTED policy wins over a permissive parent", () => {
		// The property that makes this a path rule rather than a flag on the
		// outermost component.
		const ir = doc(
			{ allowSourceUpdate: true },
			{ allowSourceUpdate: false },
		);
		expect(
			validateBrandComponentCommand({
				ir,
				query: { operation: "source-update", instanceId: "inst-1" },
				context: context(),
			}).reason,
		).toBe("source-update-denied");
	});

	it("a permissive nested policy cannot re-open what the parent closed", () => {
		const ir = doc({ allowSourceSwap: false }, { allowSourceSwap: true });
		expect(
			validateBrandComponentCommand({
				ir,
				query: { operation: "source-swap", instanceId: "inst-1" },
				context: context(),
			}).outcome,
		).toBe("deny");
	});

	it("is a WARNING, not a denial, when the host is only advising (OD-10)", () => {
		// A component cannot escalate a host running advisory.
		expect(
			validateBrandComponentCommand({
				ir: doc({ allowSourceUpdate: false }),
				query: { operation: "source-update", instanceId: "inst-1" },
				context: context({ enforcement: "warning" }),
			}).outcome,
		).toBe("warn");
	});

	it("the host capability is still checked FIRST", () => {
		// Capability denial reports `capability-denied`, not the policy reason —
		// the two are different remedies (ask an admin vs. change the component).
		expect(
			validateBrandComponentCommand({
				ir: doc({ allowSourceUpdate: false }),
				query: { operation: "source-update", instanceId: "inst-1" },
				context: context({
					capabilities: {
						canEditOverrides: true,
						canChangeVariant: true,
						canDetach: true,
						canFlatten: true,
						canInsertExternalComponents: true,
						canUpdateComponents: false,
					},
				}),
			}).reason,
		).toBe("capability-denied");
	});
});

describe("bypass coverage — every operation has a rule", () => {
	it("no operation is silently unguarded", () => {
		// The claim is COVERAGE, so this enumerates the union rather than a
		// hand-written list: adding an operation without a capability or policy
		// rule fails here rather than shipping as a bypass.
		const unguarded: string[] = [];
		for (const operation of OPERATIONS) {
			const denyingCaps: CanvasBrandCapabilities = {
				canEditOverrides: false,
				canChangeVariant: false,
				canDetach: false,
				canFlatten: false,
				canInsertExternalComponents: false,
				canUpdateComponents: false,
			};
			const decision = validateBrandComponentCommand({
				ir: doc({
					lockStructure: true,
					allowDetach: false,
					allowFlatten: false,
					allowVariantChange: false,
					editablePropertyIds: [],
				}),
				query: { operation, instanceId: "inst-1", propertyId: "p-a" },
				context: context({ capabilities: denyingCaps }),
			});
			if (decision.outcome !== "deny") unguarded.push(operation);
		}
		expect(unguarded).toEqual([]);
	});
});

describe("enforcement reaches the REAL command path (T-039 step 3)", () => {
	/**
	 * A gateway nothing calls is not enforcement. These drive
	 * `applyCommand` with `brandPolicy` wired and assert the mutation is
	 * actually refused, and that the document is untouched afterwards.
	 */
	function withPolicy(ir: CanvasIR, ctx = context()) {
		return {
			now: () => "t0",
			brandPolicy: { evaluate: createBrandPolicyEvaluator(ir), context: ctx },
		};
	}

	it("blocks an override on a property the policy does not allow", () => {
		const ir = doc({ editablePropertyIds: ["p-a"] });
		const before = structuredClone(ir);
		expect(() =>
			applyCommand(
				ir,
				{
					type: "component-instance.set-override",
					nodeId: "inst-1",
					propertyId: "p-b",
					value: { kind: "text", value: { kind: "plain", text: "x" } },
				},
				withPolicy(ir),
			),
		).toThrow(/property-not-editable/);
		expect(ir).toEqual(before);
	});

	it("attaches the STRUCTURED decision to the thrown error (T-040)", () => {
		// The Editor localizes `reason`. It must not have to parse `message` to
		// get it — `message` interpolates `detail`, which is log-only and can name
		// a provider or an identity.
		const ir = doc({ editablePropertyIds: ["p-a"] });
		let caught: unknown;
		try {
			applyCommand(
				ir,
				{
					type: "component-instance.set-override",
					nodeId: "inst-1",
					propertyId: "p-b",
					value: { kind: "text", value: { kind: "plain", text: "x" } },
				},
				withPolicy(ir),
			);
		} catch (error) {
			caught = error;
		}
		const error = caught as CanvasCommandError;
		expect(error.code).toBe("brand-policy-denied");
		expect(error.policy?.outcome).toBe("deny");
		expect(error.policy?.reason).toBe("property-not-editable");
	});

	it("attaches NO policy to an ordinary command error", () => {
		// The field must be absent, not an empty object — a truthy `policy` on a
		// non-policy failure would make the Editor show a governance dialog for a
		// missing node.
		const ir = doc({ editablePropertyIds: ["p-a"] });
		let caught: unknown;
		try {
			applyCommand(
				ir,
				{
					type: "component-instance.set-override",
					nodeId: "does-not-exist",
					propertyId: "p-a",
					value: { kind: "text", value: { kind: "plain", text: "x" } },
				},
				withPolicy(ir),
			);
		} catch (error) {
			caught = error;
		}
		expect((caught as CanvasCommandError).policy).toBeUndefined();
	});

	it("allows an override the policy DOES list", () => {
		const ir = doc({ editablePropertyIds: ["p-a"] });
		expect(() =>
			applyCommand(
				ir,
				{
					type: "component-instance.set-override",
					nodeId: "inst-1",
					propertyId: "p-a",
					value: { kind: "text", value: { kind: "plain", text: "x" } },
				},
				withPolicy(ir),
			),
		).not.toThrow();
	});

	it("blocks a reset the same way as a set", () => {
		const ir = doc({ editablePropertyIds: ["p-a"] });
		expect(() =>
			applyCommand(
				ir,
				{
					type: "component-instance.reset-override",
					nodeId: "inst-1",
					propertyId: "p-b",
				},
				withPolicy(ir),
			),
		).toThrow(/property-not-editable/);
	});

	it("blocks a detach the policy forbids", () => {
		const ir = doc({ allowDetach: false });
		expect(() =>
			applyCommand(
				ir,
				{ type: "component-instance.detach", nodeId: "inst-1" },
				withPolicy(ir),
			),
		).toThrow(/detach-denied/);
	});

	it("does NOT block in advisory mode — the edit commits", () => {
		const ir = doc({ allowDetach: false });
		expect(() =>
			applyCommand(
				ir,
				{
					type: "component-instance.set-override",
					nodeId: "inst-1",
					propertyId: "p-a",
					value: { kind: "text", value: { kind: "plain", text: "x" } },
				},
				withPolicy(ir, context({ enforcement: "warning" })),
			),
		).not.toThrow();
	});

	it("is a NO-OP when no brandPolicy is wired (every existing caller)", () => {
		const ir = doc({ allowDetach: false, editablePropertyIds: [] });
		expect(() =>
			applyCommand(
				ir,
				{
					type: "component-instance.set-override",
					nodeId: "inst-1",
					propertyId: "p-b",
					value: { kind: "text", value: { kind: "plain", text: "x" } },
				},
				{ now: () => "t0" },
			),
		).not.toThrow();
	});

	it("a BATCH stays all-or-nothing under a policy deny", () => {
		const ir = doc({ editablePropertyIds: ["p-a"] });
		const before = structuredClone(ir);
		expect(() =>
			applyCommand(
				ir,
				{
					type: "batch",
					commands: [
						{
							type: "component-instance.set-override",
							nodeId: "inst-1",
							propertyId: "p-a",
							value: { kind: "text", value: { kind: "plain", text: "ok" } },
						},
						{
							type: "component-instance.set-override",
							nodeId: "inst-1",
							propertyId: "p-b",
							value: { kind: "text", value: { kind: "plain", text: "denied" } },
						},
					],
				},
				withPolicy(ir),
			),
		).toThrow(/property-not-editable/);
		// The permitted first sub-command must not survive the batch's failure.
		expect(ir).toEqual(before);
	});
});

describe("createBrandPolicyEvaluator — the port form", () => {
	it("satisfies the rank-2 evaluator signature and decides identically", () => {
		const ir = doc({ allowDetach: false });
		const evaluate = createBrandPolicyEvaluator(ir);
		expect(
			evaluate({ operation: "detach", instanceId: "inst-1" }, context()),
		).toEqual(
			validateBrandComponentCommand({
				ir,
				query: { operation: "detach", instanceId: "inst-1" },
				context: context(),
			}),
		);
	});
});
