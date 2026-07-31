import { describe, expect, it } from "vitest";

import { canonicalizeComponentPayloadToString } from "../../component-libraries/canonicalize.js";
import { createCanvasIR } from "../../ir/builders.js";
import type { CanvasBrandComponentPolicy } from "../../ir/component-policy.js";
import type { CanvasComponentDefinition } from "../../ir/types.js";
import { CanvasIRSchema } from "../../ir/validators.js";
import type {
	CanvasBrandCapabilities,
	CanvasBrandPolicyContext,
} from "../types.js";
import {
	CANVAS_PERMISSIVE_POLICY_CONTEXT,
	isSerializablePolicyContext,
	validateBrandComponentPolicy,
} from "../types.js";

/**
 * T-036 / T-037 — portable policy, capability snapshot, policy context.
 *
 * The two claims worth proving are that a policy **participates in the digest**
 * (so it cannot be stripped without changing component identity) and that it
 * **cannot carry identity** (so replicating it is not a privacy leak).
 */

const CAPS: CanvasBrandCapabilities = {
	canEditOverrides: true,
	canChangeVariant: true,
	canDetach: true,
	canFlatten: true,
	canInsertExternalComponents: true,
	canUpdateComponents: true,
};

function definition(
	policy?: CanvasBrandComponentPolicy,
): CanvasComponentDefinition {
	return {
		id: "cmp",
		name: "Card",
		revision: 1,
		root: {
			id: "root",
			type: "frame",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			children: [],
		},
		properties: [
			{
				id: "p-title",
				name: "Title",
				nodeId: "n1",
				kind: "text",
				targetKind: "text",
			},
		],
		...(policy ? { policy } : {}),
	} as CanvasComponentDefinition;
}

describe("policy participates in the canonical digest (T-036 DoD)", () => {
	it("changes the canonical bytes when the policy changes", () => {
		// This is what makes a policy tamper-evident: it rides in the payload the
		// integrity digest covers, so stripping or editing it changes the
		// component's identity rather than silently loosening it.
		const without = canonicalizeComponentPayloadToString(definition());
		const withPolicy = canonicalizeComponentPayloadToString(
			definition({ lockStructure: true }),
		);
		const loosened = canonicalizeComponentPayloadToString(
			definition({ lockStructure: false }),
		);
		expect(withPolicy).not.toBe(without);
		expect(loosened).not.toBe(withPolicy);
	});

	it("is order-independent, like the rest of the canonical form", () => {
		const a = canonicalizeComponentPayloadToString(
			definition({ lockStructure: true, allowDetach: false }),
		);
		const b = canonicalizeComponentPayloadToString(
			definition({ allowDetach: false, lockStructure: true }),
		);
		expect(a).toBe(b);
	});

	it("survives a document round trip", () => {
		const policy: CanvasBrandComponentPolicy = {
			editablePropertyIds: ["p-title"],
			lockStructure: true,
			recommendedEnforcement: "blocking",
		};
		const base = createCanvasIR({ id: "doc", now: () => "t0" });
		const doc = { ...base, components: { cmp: definition(policy) } };
		const parsed = CanvasIRSchema.parse(structuredClone(doc));
		expect(parsed.components?.cmp?.policy).toEqual(policy);
	});
});

describe("a policy cannot carry identity (T-036 SEC)", () => {
	it.each([
		"allowedUserIds",
		"roles",
		"tenantId",
		"memberEmails",
		"apiKey",
		"credentials",
		"grantedPermissions",
		"actorId",
	])("rejects the identity-shaped field %j", (field) => {
		const issues = validateBrandComponentPolicy({
			[field]: ["someone"],
		} as unknown as CanvasBrandComponentPolicy);
		expect(issues.map((i) => i.code)).toContain("policy-identity-field");
	});

	it("catches an identity field smuggled through the LOOSE schema", () => {
		// The persisted schema preserves unknown keys (CON-5), so a host could
		// otherwise replicate `{ allowedUserIds }` to every peer. The scan runs
		// over the policy's own keys precisely because they survive.
		const policy = { lockStructure: true, allowedUserIds: ["u1"] };
		const base = createCanvasIR({ id: "doc", now: () => "t0" });
		const parsed = CanvasIRSchema.parse({
			...base,
			components: {
				cmp: definition(policy as unknown as CanvasBrandComponentPolicy),
			},
		});
		const stored = parsed.components?.cmp?.policy as CanvasBrandComponentPolicy;
		expect(validateBrandComponentPolicy(stored).map((i) => i.code)).toContain(
			"policy-identity-field",
		);
	});

	it("does NOT false-positive on the legitimate policy fields", () => {
		// `tokenConstraints` and `recommendedEnforcement` contain identity-ish
		// substrings; the known-good keys are exempted rather than the patterns
		// weakened.
		expect(
			validateBrandComponentPolicy(
				{
					editablePropertyIds: ["p-title"],
					tokenConstraints: {
						"p-title": { tokenType: "color", allowLiteral: false },
					},
					lockStructure: true,
					allowDetach: false,
					allowFlatten: false,
					allowVariantChange: false,
					recommendedEnforcement: "blocking",
				},
				["p-title"],
			),
		).toEqual([]);
	});
});

describe("policy validation against its definition (T-036 step 3)", () => {
	it("rejects an editable property the component does not advertise", () => {
		const issues = validateBrandComponentPolicy(
			{ editablePropertyIds: ["p-ghost"] },
			["p-title"],
		);
		expect(issues[0]?.code).toBe("policy-unknown-property");
	});

	it("rejects a token constraint on an unknown property", () => {
		const issues = validateBrandComponentPolicy(
			{ tokenConstraints: { "p-ghost": { tokenType: "color" } } },
			["p-title"],
		);
		expect(issues.map((i) => i.code)).toContain(
			"policy-unknown-token-constraint",
		);
	});

	it("flags a constraint that permits nothing at all", () => {
		// Empty allowlist AND literals denied means the property can never be
		// given a value — it presents to a user as an unexplained refusal.
		const issues = validateBrandComponentPolicy(
			{
				tokenConstraints: {
					"p-title": {
						tokenType: "color",
						allowedTokenIds: [],
						allowLiteral: false,
					},
				},
			},
			["p-title"],
		);
		expect(issues.map((i) => i.code)).toContain(
			"policy-empty-token-allowlist-with-literals-denied",
		);
	});

	it("distinguishes an ABSENT allowlist from an EMPTY one", () => {
		// Absent = "any token of this type"; empty = "none". Collapsing them
		// would turn a permissive policy into a total denial.
		expect(
			validateBrandComponentPolicy(
				{ tokenConstraints: { "p-title": { tokenType: "color" } } },
				["p-title"],
			),
		).toEqual([]);
	});

	it("reports every issue, not just the first", () => {
		const issues = validateBrandComponentPolicy(
			{
				editablePropertyIds: ["p-ghost"],
				tokenConstraints: { "p-other": { tokenType: "color" } },
				allowedUserIds: ["u"],
			} as unknown as CanvasBrandComponentPolicy,
			["p-title"],
		);
		expect(issues.length).toBeGreaterThanOrEqual(3);
	});
});

describe("policy context is data, never callbacks (T-037 DoD)", () => {
	const context: CanvasBrandPolicyContext = {
		enforcement: "blocking",
		capabilities: {
			...CAPS,
			editablePropertyIdsByInstance: { "inst-1": ["p-title"] },
		},
		resolvedBrandKitId: "kit-1",
		policyRevision: "rev-7",
	};

	it("round-trips through JSON unchanged", () => {
		expect(JSON.parse(JSON.stringify(context))).toEqual(context);
	});

	it("detects a function-valued field", () => {
		expect(isSerializablePolicyContext(context)).toBe(true);
		expect(
			isSerializablePolicyContext({
				...context,
				capabilities: {
					...CAPS,
					// A callback would make the same command decide differently on
					// replay, on a peer, or in a worker.
					canDetach: (() => true) as unknown as boolean,
				},
			}),
		).toBe(false);
	});

	it("keys per-instance capability by the PAGE-LEVEL instance id (OD-08)", () => {
		// Not a virtual node id: a virtual id is derived from a resolution and
		// changes when a Source or variant changes, so a capability keyed on one
		// would silently lapse on the next edit.
		const byInstance = context.capabilities.editablePropertyIdsByInstance;
		expect(Object.keys(byInstance ?? {})).toEqual(["inst-1"]);
		expect(byInstance?.["inst-1"]).toEqual(["p-title"]);
	});

	it("ships a permissive default that denies nothing", () => {
		expect(CANVAS_PERMISSIVE_POLICY_CONTEXT.enforcement).toBe("off");
		expect(
			Object.values(CANVAS_PERMISSIVE_POLICY_CONTEXT.capabilities).every(
				(v) => v === true || typeof v === "object",
			),
		).toBe(true);
		expect(isSerializablePolicyContext(CANVAS_PERMISSIVE_POLICY_CONTEXT)).toBe(
			true,
		);
	});
});
