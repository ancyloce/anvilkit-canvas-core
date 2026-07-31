import { describe, expect, expectTypeOf, it } from "vitest";

import {
	CanvasCommandError,
	type CanvasCommandErrorCode,
} from "../../commands/runtime.js";
import {
	CANVAS_COMPONENT_ABORTING_CODES,
	CANVAS_COMPONENT_DIAGNOSTIC_CODES,
	type CanvasComponentAbortingCode,
	type CanvasComponentDiagnosticCode,
	componentDiagnostic,
	componentDiagnosticSeverity,
	isCanvasComponentAbortingCode,
	isCanvasComponentDiagnosticCode,
} from "../diagnostics.js";

/**
 * T-011: the 13 stable diagnostics, the 5 aborting command-error codes, and the
 * guarantee that the two unions cannot drift.
 */

/** PRD §9.16, transcribed independently of the implementation's array. */
const PRD_DIAGNOSTICS = [
	"component-provider-offline",
	"component-provider-unauthorized",
	"component-version-missing",
	"component-version-deprecated",
	"component-integrity-mismatch",
	"component-snapshot-missing",
	"component-snapshot-invalid",
	"component-dependency-missing",
	"component-update-incompatible",
	"component-variant-invalid",
	"component-swap-incompatible",
	"component-override-migration-orphan",
	"component-library-capability-denied",
] as const;

describe("CanvasComponentDiagnosticCode — matches PRD §9.16", () => {
	it("declares exactly the 13 documented codes, in order", () => {
		expect(CANVAS_COMPONENT_DIAGNOSTIC_CODES).toEqual(PRD_DIAGNOSTICS);
		expect(CANVAS_COMPONENT_DIAGNOSTIC_CODES).toHaveLength(13);
	});

	it("has no duplicates", () => {
		expect(new Set(CANVAS_COMPONENT_DIAGNOSTIC_CODES).size).toBe(13);
	});

	it("is a closed union, not string", () => {
		// If the union ever widened to `string`, this would still compile for the
		// valid value but the negative case below would too.
		expectTypeOf<CanvasComponentDiagnosticCode>().toEqualTypeOf<
			(typeof PRD_DIAGNOSTICS)[number]
		>();
		// @ts-expect-error an arbitrary string is not a diagnostic code
		const invalid: CanvasComponentDiagnosticCode = "made-up-code";
		expect(invalid).toBe("made-up-code");
	});

	it("switches exhaustively without a default branch", () => {
		// The compile-time payoff of a closed union: `never` in the exhausted
		// position means adding a code breaks this function until it's handled.
		function describeCode(code: CanvasComponentDiagnosticCode): string {
			switch (code) {
				case "component-provider-offline":
				case "component-provider-unauthorized":
					return "provider";
				case "component-version-missing":
				case "component-version-deprecated":
					return "version";
				case "component-integrity-mismatch":
				case "component-snapshot-missing":
				case "component-snapshot-invalid":
					return "snapshot";
				case "component-dependency-missing":
					return "dependency";
				case "component-update-incompatible":
				case "component-swap-incompatible":
					return "lifecycle";
				case "component-variant-invalid":
					return "variant";
				case "component-override-migration-orphan":
					return "override";
				case "component-library-capability-denied":
					return "capability";
				default: {
					const exhausted: never = code;
					return exhausted;
				}
			}
		}

		for (const code of CANVAS_COMPONENT_DIAGNOSTIC_CODES) {
			expect(describeCode(code)).toBeTruthy();
		}
	});

	it("recognizes its own codes and rejects others", () => {
		for (const code of CANVAS_COMPONENT_DIAGNOSTIC_CODES) {
			expect(isCanvasComponentDiagnosticCode(code)).toBe(true);
		}
		for (const value of [
			"node-not-found",
			"brand-policy-denied",
			"",
			undefined,
			null,
			42,
			{},
		]) {
			expect(isCanvasComponentDiagnosticCode(value)).toBe(false);
		}
	});

	it("assigns every code a severity", () => {
		for (const code of CANVAS_COMPONENT_DIAGNOSTIC_CODES) {
			expect(["error", "warning", "info"]).toContain(
				componentDiagnosticSeverity(code),
			);
		}
	});

	it("treats unreadable-content conditions as errors and environmental ones as info", () => {
		// The distinction that matters to the UI: an offline Provider does not stop
		// a document rendering, because the stored snapshot is the render authority.
		expect(componentDiagnosticSeverity("component-provider-offline")).toBe(
			"info",
		);
		expect(componentDiagnosticSeverity("component-snapshot-missing")).toBe(
			"error",
		);
		expect(componentDiagnosticSeverity("component-integrity-mismatch")).toBe(
			"error",
		);
		expect(componentDiagnosticSeverity("component-version-deprecated")).toBe(
			"warning",
		);
	});
});

describe("componentDiagnostic", () => {
	it("defaults severity from the code", () => {
		expect(componentDiagnostic("component-snapshot-missing", "gone")).toEqual({
			code: "component-snapshot-missing",
			message: "gone",
			severity: "error",
		});
	});

	it("allows an explicit severity override and carries context", () => {
		expect(
			componentDiagnostic("component-version-deprecated", "old", {
				severity: "info",
				snapshotKey: "lib/comp/1.0.0/sha256-AAAA",
				nodeId: "node-1",
			}),
		).toEqual({
			code: "component-version-deprecated",
			message: "old",
			severity: "info",
			snapshotKey: "lib/comp/1.0.0/sha256-AAAA",
			nodeId: "node-1",
		});
	});

	it("omits absent context keys rather than setting them undefined", () => {
		// Matters for canonicalization: an explicit `undefined` and an absent key
		// must not be able to differ anywhere this shape gets hashed or compared.
		const diagnostic = componentDiagnostic(
			"component-provider-offline",
			"down",
		);
		expect(Object.keys(diagnostic).sort()).toEqual([
			"code",
			"message",
			"severity",
		]);
	});
});

describe("CanvasCommandErrorCode — the 5 aborting codes (T-011)", () => {
	const NEW_COMMAND_CODES = [
		"component-library-capability-denied",
		"component-integrity-mismatch",
		"component-snapshot-missing",
		"component-dependency-missing",
		"brand-policy-denied",
	] as const;

	it("accepts each new code on CanvasCommandError", () => {
		for (const code of NEW_COMMAND_CODES) {
			const error = new CanvasCommandError(code, `refused: ${code}`);
			expect(error.code).toBe(code);
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe("CanvasCommandError");
		}
	});

	it("still rejects an arbitrary string", () => {
		expectTypeOf<CanvasCommandErrorCode>().not.toEqualTypeOf<string>();
		// @ts-expect-error not a member of the closed union
		const invalid: CanvasCommandErrorCode = "totally-made-up";
		expect(invalid).toBe("totally-made-up");
	});

	it("preserved the pre-existing 12 codes", () => {
		// Widening must be additive: an existing consumer's switch cannot break.
		const preExisting = [
			"node-not-found",
			"parent-not-found",
			"parent-not-group",
			"page-not-found",
			"location-not-found",
			"kind-mismatch",
			"asset-mismatch",
			"asset-not-found",
			"index-out-of-range",
			"invariant-violated",
			"node-locked",
			"unknown-command",
		] as const satisfies readonly CanvasCommandErrorCode[];
		expect(preExisting).toHaveLength(12);
	});
});

describe("the two unions cannot drift apart", () => {
	it("every aborting code is BOTH a diagnostic and a command-error code", () => {
		expect(CANVAS_COMPONENT_ABORTING_CODES).toHaveLength(4);
		for (const code of CANVAS_COMPONENT_ABORTING_CODES) {
			// Runtime half.
			expect(CANVAS_COMPONENT_DIAGNOSTIC_CODES).toContain(code);
			expect(() => new CanvasCommandError(code, "x")).not.toThrow();
			expect(isCanvasComponentAbortingCode(code)).toBe(true);
		}
		// Type half — these are the assertions that actually stop a rename.
		expectTypeOf<CanvasComponentAbortingCode>().toExtend<CanvasComponentDiagnosticCode>();
		expectTypeOf<CanvasComponentAbortingCode>().toExtend<CanvasCommandErrorCode>();
	});

	it("brand-policy-denied is a command error but NOT a component diagnostic", () => {
		// It belongs to brand governance, which reports through the compliance
		// report rather than this union — recorded here so the asymmetry is
		// deliberate rather than an oversight someone later "fixes".
		expect(isCanvasComponentDiagnosticCode("brand-policy-denied")).toBe(false);
		expect(new CanvasCommandError("brand-policy-denied", "x").code).toBe(
			"brand-policy-denied",
		);
	});

	it("non-aborting diagnostics are not command-error codes", () => {
		const nonAborting = CANVAS_COMPONENT_DIAGNOSTIC_CODES.filter(
			(code) => !isCanvasComponentAbortingCode(code),
		);
		expect(nonAborting).toHaveLength(9);
		// e.g. a deprecated version must never abort a command — it is advice.
		expect(nonAborting).toContain("component-version-deprecated");
		expect(nonAborting).toContain("component-provider-offline");
	});
});
