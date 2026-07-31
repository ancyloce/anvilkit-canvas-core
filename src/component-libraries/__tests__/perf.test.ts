import { describe, expect, it } from "vitest";
import type { BrandKitDefinition } from "../../brand/index.js";
import { generateGovernedComplianceReport } from "../../brand-governance/compliance.js";
import type { CanvasBrandPolicyContext } from "../../brand-governance/types.js";
import { resolveComponentInstance } from "../../components/resolve.js";
import {
	createCanvasIR,
	createComponentInstance,
	createGroup,
	createRect,
} from "../../ir/builders.js";
import type {
	CanvasComponentDefinition,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import {
	compareComponentDefinitions,
	migrateComponentOverrides,
} from "../compatibility.js";

/**
 * @file The four NFR §14.1 budgets (plan 0021 T-052).
 *
 * ## Why these are assertions with generous margins, not microbenchmarks
 *
 * The PRD's numbers are p95 targets on "the agreed reference environment".
 * This box is WSL2 on a shared machine with a background IDE server; a test
 * that asserted 100 ms here would measure the host's mood and fail in CI for
 * reasons no one could act on. What a test CAN do reliably is catch an
 * algorithmic regression — an accidental O(n²), a cache that stopped hitting —
 * because those change the number by an order of magnitude, not by 30%.
 *
 * So each budget is asserted at a multiple of the PRD target, and the measured
 * value is printed. The multiple is the environment allowance; the shape of the
 * curve is what is really under test. A true p95 gate belongs in the perf CI
 * harness with a pinned runner, and is recorded as a follow-up.
 *
 * `MULTIPLIER` is the one knob. Raising it to make a red test green is exactly
 * the move this comment exists to make visible.
 */

const MULTIPLIER = 8;

/** Measure the median of `runs` executions, in milliseconds. */
function median(runs: number, fn: () => void): number {
	const samples: number[] = [];
	for (let i = 0; i < runs; i += 1) {
		const start = performance.now();
		fn();
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)] as number;
}

function expectWithin(label: string, measured: number, budgetMs: number): void {
	const allowed = budgetMs * MULTIPLIER;
	// Printed so a real regression is diagnosable from CI output alone.
	console.info(
		`[perf] ${label}: ${measured.toFixed(1)}ms (PRD budget ${budgetMs}ms, asserted <= ${allowed}ms)`,
	);
	expect(measured).toBeLessThan(allowed);
}

const KIT: BrandKitDefinition = {
	id: "kit",
	name: "Kit",
	logos: [],
	colors: [{ id: "brand-blue", name: "Brand Blue", value: "#2563eb" }],
	fonts: [{ id: "brand-sans", name: "Brand Sans", family: "Inter" }],
	typography: [],
	rules: [{ id: "no-red", kind: "forbidden-color", value: "#ff0000" }],
};

function context(): CanvasBrandPolicyContext {
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
	};
}

function definition(propertyCount: number): CanvasComponentDefinition {
	const children: CanvasNode[] = Array.from(
		{ length: 8 },
		(_, i) =>
			createRect({
				id: `card-n${i}`,
				bounds: { width: 4, height: 4 },
				fill: i % 3 === 0 ? "#ff0000" : "#2563eb",
			}) as CanvasNode,
	);
	return {
		id: "card",
		name: "Card",
		revision: 1,
		root: createGroup({ id: "card-root", children }),
		properties: Array.from({ length: propertyCount }, (_, i) => ({
			id: `p-${i}`,
			name: `P${i}`,
			nodeId: `card-n${i % 8}`,
			kind: "color",
			targetKind: "fill",
			semanticKey: `acme:p${i}`,
		})),
	} as unknown as CanvasComponentDefinition;
}

/** The §14.1 fixture: 500 instances inside a ~1,000-node document. */
function bigDocument(instanceCount = 500): CanvasIR {
	const base = createCanvasIR({ id: "perf-doc", now: () => "t0" });
	const children: CanvasNode[] = [];
	for (let i = 0; i < instanceCount; i += 1) {
		children.push(
			createComponentInstance({
				id: `inst-${i}`,
				componentId: "card",
				bounds: { width: 10, height: 10 },
			}) as CanvasNode,
		);
		children.push(
			createRect({
				id: `plain-${i}`,
				bounds: { width: 10, height: 10 },
				fill: i % 5 === 0 ? "#ff0000" : "#2563eb",
			}) as CanvasNode,
		);
	}
	const page = {
		...base.pages[0],
		root: createGroup({ id: "perf-root", children }),
	};
	return {
		...base,
		pages: [page],
		components: { card: definition(16) },
	} as CanvasIR;
}

describe("NFR §14.1 performance budgets (T-052)", () => {
	it("compliance scan of a 1,000-node / 500-instance document (p95 <= 100 ms)", () => {
		const ir = bigDocument(500);
		// Sanity: the fixture really is the size the budget describes. A budget
		// met on a tiny document is the classic way a perf test stops meaning
		// anything.
		expect(ir.pages[0]?.root.children).toHaveLength(1000);

		const measured = median(5, () => {
			generateGovernedComplianceReport(ir, KIT, context());
		});
		expectWithin("compliance scan (1000 nodes / 500 instances)", measured, 100);
	});

	it("cached insertion to resolved render (p95 <= 100 ms)", () => {
		const ir = bigDocument(1);
		const instance = ir.pages[0]?.root.children?.[0] as CanvasNode;
		// Warm the resolver the way a real second insert would be.
		resolveComponentInstance(ir.components, instance as never, {});
		const measured = median(20, () => {
			resolveComponentInstance(ir.components, instance as never, {});
		});
		expectWithin("cached instance resolution", measured, 100);
	});

	it("update comparison for 500 instances (p95 <= 250 ms)", () => {
		const from = definition(16);
		const to = {
			...definition(16),
			revision: 2,
			properties: definition(16).properties.slice(0, 12),
		} as CanvasComponentDefinition;

		const measured = median(5, () => {
			const report = compareComponentDefinitions(from, to);
			// The comparison is per-definition; the 500 is the override MIGRATION
			// that follows it, which is the part that scales with instance count.
			for (let i = 0; i < 500; i += 1) {
				migrateComponentOverrides(
					Object.fromEntries(
						from.properties.map((p) => [
							p.id,
							{ kind: "color", value: "#ff0000" },
						]),
					) as never,
					report,
				);
			}
		});
		expectWithin("update comparison + 500 override migrations", measured, 250);
	});

	it("scales LINEARLY, not quadratically, with instance count", () => {
		// The assertion that survives a slow machine: doubling the document must
		// not quadruple the time. An accidental O(n²) shows up here even when the
		// absolute numbers are meaningless.
		const small = median(5, () => {
			generateGovernedComplianceReport(bigDocument(125), KIT, context());
		});
		const large = median(5, () => {
			generateGovernedComplianceReport(bigDocument(500), KIT, context());
		});
		const ratio = large / Math.max(small, 0.01);
		console.info(
			`[perf] 4x document -> ${ratio.toFixed(1)}x time (linear would be ~4x)`,
		);
		// Generous: 4x work should be ~4x time. Quadratic would be ~16x. The
		// threshold sits between them, far from both.
		expect(ratio).toBeLessThan(10);
	});
});
