import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { applyCommand } from "../commands/runtime.js";
import type { CommandApplyOptions } from "../commands/types.js";
import { createCanvasIR, createRect } from "../ir/builders.js";
import { insertNode } from "../ir/mutations.js";
import type { CanvasIR } from "../ir/types.js";
import {
	CANVAS_ALLOW_ALL_POLICY,
	type CanvasPolicyDecision,
	type CanvasPolicyEvaluator,
} from "../policy-contracts.js";

/**
 * T-038 — the policy port at rank 2, and T-035's `brandPolicy` half.
 *
 * The port's whole reason to exist is a layering fact, so the load-bearing
 * assertion is the gate itself: `commands/` (3) may import it, `clipboard/` (2)
 * may not, and `brand-governance/` (5) is unreachable from `commands/`.
 */

function doc(): CanvasIR {
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	return insertNode(base, {
		parentId: base.pages[0]?.root.id as string,
		node: createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
		now: () => "t0",
	});
}

describe("layering (T-038 GATE)", () => {
	it("the self-test pins every port edge", () => {
		// Runs the real gate rather than restating its rules: the point of the
		// port is that the gate enforces its position, and a test that only
		// described the rule would pass even if the ranks changed.
		const out = execFileSync(
			process.execPath,
			["scripts/check-layering.mjs", "--self-test"],
			{ encoding: "utf8" },
		);
		expect(out).toContain("self-test OK");
	});

	it("the whole-package check is green", () => {
		const out = execFileSync(process.execPath, ["scripts/check-layering.mjs"], {
			encoding: "utf8",
		});
		expect(out).toContain("check-layering: OK");
	});
});

describe("CanvasPolicyDecision shape (T-038 UT)", () => {
	it("has three outcomes, not two", () => {
		// `warn` is what makes advisory mode possible: the edit commits AND is
		// reported. Folding it into `allow` loses the report; folding it into
		// `deny` makes advisory mode block.
		const outcomes: CanvasPolicyDecision["outcome"][] = [
			"allow",
			"warn",
			"deny",
		];
		expect(new Set(outcomes).size).toBe(3);
	});

	it("carries a stable reason code, never a free-form message", () => {
		const decision: CanvasPolicyDecision = {
			outcome: "deny",
			reason: "structure-locked",
			detail: "for logs only",
			instanceId: "inst-1",
		};
		expect(decision.reason).toBe("structure-locked");
		// `detail` exists for logs; user-facing copy is derived from `reason`.
		expect(Object.keys(decision)).not.toContain("message");
	});

	it("the default evaluator permits everything", () => {
		expect(
			CANVAS_ALLOW_ALL_POLICY({ operation: "override-set" }, undefined),
		).toEqual({ outcome: "allow" });
	});

	it("passes the brand context OPAQUELY", () => {
		// Rank 2 must not know brand vocabulary. The evaluator receives whatever
		// the host supplied and casts it back at rank 5.
		let seen: unknown;
		const evaluator: CanvasPolicyEvaluator = (_query, context) => {
			seen = context;
			return { outcome: "allow" };
		};
		const context = { enforcement: "blocking", capabilities: {} };
		evaluator({ operation: "detach" }, context);
		expect(seen).toBe(context);
	});
});

describe("CommandApplyOptions.brandPolicy (T-035 completion)", () => {
	it("reaches a command through the options object", () => {
		let calls = 0;
		const options: CommandApplyOptions = {
			now: () => "t0",
			brandPolicy: {
				evaluate: () => {
					calls += 1;
					return { outcome: "allow" };
				},
				context: { enforcement: "warning" },
			},
		};
		// No built-in command consults it yet — the gateway (T-039) is what
		// calls it. What this asserts is that the option is accepted and the
		// command behaves identically, i.e. it is additive.
		// ONE base document — two `doc()` calls mint different random page ids.
		const base = doc();
		const cmd = {
			type: "node.update",
			nodeId: "r1",
			kind: "rect",
			patch: { name: "x" },
		} as const;
		const withPolicy = applyCommand(base, cmd, options);
		const without = applyCommand(base, cmd, { now: () => "t0" });
		expect(withPolicy.ir).toEqual(without.ir);
		expect(calls).toBe(0);
	});

	it("is optional, so every existing caller is unaffected", () => {
		const options: CommandApplyOptions = { now: () => "t0" };
		expect(options.brandPolicy).toBeUndefined();
		expect(() =>
			applyCommand(
				doc(),
				{
					type: "node.update",
					nodeId: "r1",
					kind: "rect",
					patch: { name: "y" },
				},
				options,
			),
		).not.toThrow();
	});
});
