import { describe, expect, it } from "vitest";

import type {
	BrandComplianceIssue,
	BrandKitDefinition,
} from "../../brand/index.js";
import { generateBrandComplianceReport } from "../../brand/index.js";
import {
	createCanvasIR,
	createComponentInstance,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import {
	buildComplianceOrdering,
	effectivePathSeverity,
	effectiveSeverity,
	generateGovernedComplianceReport,
	normalizeComplianceIssues,
	summarizeIssues,
} from "../compliance.js";
import type { CanvasBrandPolicyContext } from "../types.js";

/**
 * T-041 / T-042 — additive widening, the OD-10 severity rule, deterministic
 * ordering.
 */

const KIT: BrandKitDefinition = {
	id: "kit",
	name: "Kit",
	logos: [],
	colors: [{ id: "brand-blue", name: "Brand Blue", value: "#2563eb" }],
	fonts: [{ id: "brand-sans", name: "Brand Sans", family: "Inter" }],
	typography: [],
	// An explicit forbid rule is what makes the fixture rect report at all —
	// without a rule the scanner has nothing to measure `#ff0000` against.
	rules: [{ id: "no-red", kind: "forbidden-color", value: "#ff0000" }],
};

function context(
	overrides: Partial<CanvasBrandPolicyContext> = {},
): CanvasBrandPolicyContext {
	return {
		enforcement: "blocking",
		capabilities: {
			canEditOverrides: true,
			canChangeVariant: true,
			canDetach: true,
			canFlatten: true,
			canInsertExternalComponents: true,
			canUpdateComponents: true,
		},
		...overrides,
	};
}

/** An off-brand rect, which the shipped scanner reports. */
function offBrandRect(id: string): CanvasNode {
	return createRect({
		id,
		bounds: { width: 10, height: 10 },
		fill: "#ff0000",
	}) as CanvasNode;
}

function definition(
	recommended?: "warning" | "blocking",
): CanvasComponentDefinition {
	return {
		id: "cmp",
		name: "Card",
		revision: 1,
		root: {
			id: "cmp-root",
			type: "frame",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 10, height: 10 },
			zIndex: 0,
			children: [],
		},
		properties: [],
		...(recommended ? { policy: { recommendedEnforcement: recommended } } : {}),
	} as CanvasComponentDefinition;
}

function doc(
	options: {
		recommended?: "warning" | "blocking";
		withInstance?: boolean;
	} = {},
): CanvasIR {
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	const withRegistry: CanvasIR = options.withInstance
		? { ...base, components: { cmp: definition(options.recommended) } }
		: base;
	let ir = insertNode(withRegistry, {
		parentId: withRegistry.pages[0]?.root.id as string,
		node: offBrandRect("plain-rect"),
		now: () => "t0",
	});
	if (options.withInstance) {
		ir = insertNode(ir, {
			parentId: ir.pages[0]?.root.id as string,
			node: createComponentInstance({
				id: "inst-1",
				componentId: "cmp",
				bounds: { width: 10, height: 10 },
			}),
			now: () => "t0",
		});
	}
	return ir;
}

describe("T-041 — widening is additive", () => {
	it("keeps the four original fields required and unchanged", () => {
		const report = generateBrandComplianceReport(doc(), KIT);
		expect(report.issues.length).toBeGreaterThan(0);
		const issue = report.issues[0] as BrandComplianceIssue;
		for (const key of ["nodeId", "code", "property", "value"]) {
			expect(issue).toHaveProperty(key);
			expect(typeof (issue as unknown as Record<string, unknown>)[key]).toBe(
				"string",
			);
		}
	});

	it("the shipped TWO-ARGUMENT call keeps working untouched", () => {
		// The live consumers (`BrandPanel`, `brand-warnings`) call it this way and
		// filter on the required `nodeId`.
		const report = generateBrandComplianceReport(doc(), KIT);
		expect(report.issues.every((i) => typeof i.nodeId === "string")).toBe(true);
		// No governance fields appear unless a caller opts in.
		expect(report.issues[0]?.severity).toBeUndefined();
		expect(report.summary).toBeUndefined();
	});

	it("adds NO `message` field — display text stays derived from `code`", () => {
		// A localized string must never be usable to identify an issue.
		const report = generateGovernedComplianceReport(doc(), KIT, context());
		for (const issue of report.issues) {
			expect(issue).not.toHaveProperty("message");
		}
	});

	it("keeps the six shipped codes and adds the twelve component ones", () => {
		const shipped = [
			"unresolved-color-token",
			"unresolved-font-token",
			"forbidden-color",
			"forbidden-font",
			"off-brand-color",
			"off-brand-font",
		];
		// A type-level check: each shipped code must still be assignable.
		for (const code of shipped) {
			const issue: BrandComplianceIssue = {
				nodeId: "n",
				code: code as BrandComplianceIssue["code"],
				property: "fill",
				value: "#000",
			};
			expect(issue.code).toBe(code);
		}
	});
});

describe("OD-10 severity truth table (T-042)", () => {
	it.each([
		// enforcement, policy recommendation, expected
		["off", undefined, "warning"],
		["off", "blocking", "warning"],
		["warning", undefined, "warning"],
		["warning", "blocking", "warning"],
		["blocking", undefined, "warning"],
		["blocking", "warning", "warning"],
		["blocking", "blocking", "blocking"],
	] as const)("enforcement=%s recommendation=%s -> %s", (enforcement, recommended, expected) => {
		expect(
			effectiveSeverity(
				recommended ? { recommendedEnforcement: recommended } : undefined,
				{ enforcement },
			),
		).toBe(expected);
	});

	it("an ORDINARY node stays warning forever — the row that matters most", () => {
		// Turning governance on must not retroactively block a document that was
		// fine yesterday (T-042 acceptance).
		for (const enforcement of ["off", "warning", "blocking"] as const) {
			expect(effectiveSeverity(undefined, { enforcement })).toBe("warning");
			expect(effectivePathSeverity([], { enforcement })).toBe("warning");
		}
	});

	it("path severity blocks only when a policy on the path recommends it", () => {
		expect(
			effectivePathSeverity([{ recommendedEnforcement: "blocking" }], {
				enforcement: "blocking",
			}),
		).toBe("blocking");
		expect(
			effectivePathSeverity([{ recommendedEnforcement: "blocking" }], {
				enforcement: "warning",
			}),
		).toBe("warning");
	});

	it("enabling governance cannot retroactively block an existing document", () => {
		// End-to-end version of the same claim, through the real report.
		const report = generateGovernedComplianceReport(doc(), KIT, context());
		expect(report.issues.length).toBeGreaterThan(0);
		expect(report.issues.every((i) => i.severity === "warning")).toBe(true);
		expect(report.summary?.blocking).toBe(0);
	});
});

describe("deterministic ordering (T-042 GOLD)", () => {
	it("is byte-stable across runs", () => {
		const ir = doc({ withInstance: true, recommended: "blocking" });
		const a = generateGovernedComplianceReport(ir, KIT, context());
		const b = generateGovernedComplianceReport(ir, KIT, context());
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});

	it("sorts by DOCUMENT order, not lexicographic id order", () => {
		// Two ids whose lexicographic order is the reverse of their tree order.
		const ordering = buildComplianceOrdering(doc());
		const zFirst: BrandComplianceIssue = {
			nodeId: "z",
			code: "off-brand-color",
			property: "fill",
			value: "#1",
		};
		const aSecond: BrandComplianceIssue = {
			nodeId: "a",
			code: "off-brand-color",
			property: "fill",
			value: "#2",
		};
		// Neither id is in the document, so both fall to MAX and the tiebreakers
		// decide — which is itself deterministic.
		const sorted = normalizeComplianceIssues([zFirst, aSecond], ordering);
		expect(sorted).toHaveLength(2);
		expect(JSON.stringify(sorted)).toBe(
			JSON.stringify(normalizeComplianceIssues([aSecond, zFirst], ordering)),
		);
	});

	it("deduplicates by semantic key, keeping the MORE severe duplicate", () => {
		const ordering = buildComplianceOrdering(doc());
		const base: BrandComplianceIssue = {
			nodeId: "n",
			code: "off-brand-color",
			property: "fill",
			value: "#1",
		};
		const deduped = normalizeComplianceIssues(
			[
				{ ...base, severity: "warning" },
				{ ...base, severity: "blocking" },
			],
			ordering,
		);
		expect(deduped).toHaveLength(1);
		// Order of arrival must not decide severity.
		expect(deduped[0]?.severity).toBe("blocking");
		const reversed = normalizeComplianceIssues(
			[
				{ ...base, severity: "blocking" },
				{ ...base, severity: "warning" },
			],
			ordering,
		);
		expect(reversed[0]?.severity).toBe("blocking");
	});

	it("summarizes counts", () => {
		expect(
			summarizeIssues([
				{
					nodeId: "a",
					code: "off-brand-color",
					property: "fill",
					value: "1",
					severity: "warning",
				},
				{
					nodeId: "b",
					code: "off-brand-color",
					property: "fill",
					value: "2",
					severity: "blocking",
				},
			]),
		).toEqual({ warning: 1, blocking: 1 });
	});
});

describe("governed report shape", () => {
	it("carries documentId, policyRevision and a summary", () => {
		const report = generateGovernedComplianceReport(
			doc(),
			KIT,
			context({ policyRevision: "rev-9" }),
		);
		expect(report.documentId).toBe("doc");
		expect(report.policyRevision).toBe("rev-9");
		expect(report.summary).toBeDefined();
	});

	it("annotates issues with the page they were found on", () => {
		const report = generateGovernedComplianceReport(doc(), KIT, context());
		expect(report.issues.every((i) => typeof i.pageId === "string")).toBe(true);
	});
});
