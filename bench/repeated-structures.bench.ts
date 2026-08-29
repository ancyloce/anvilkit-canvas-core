/**
 * @file Pre-component repeated-structures baseline (plan 0023, M0-03).
 *
 * Run with `pnpm bench:components` (or `pnpm bench` for every harness).
 *
 * Records what full-document resolution costs TODAY for documents holding
 * 1 / 10 / 100 / 500 independent copies of the same marketing card, built
 * from plain nodes with no component concept. The M2 component resolver is
 * measured against these same documents — NFR-001's "100 instances p95 ≤
 * 100 ms" is only falsifiable relative to this record, which is why it is
 * an M0 deliverable (R-1).
 *
 * Report-only by design: the figures here are a reference point, not a
 * budget — there is nothing to gate until the component resolver exists.
 * The committed record lives in `bench/baselines/pre-component.json`;
 * re-measure it (3 consecutive runs, medians within 10%) whenever the
 * reference environment in `harness.ts` changes.
 */

import { arch, cpus, platform, totalmem } from "node:os";
import { describe, expect, it } from "vitest";
import type { CanvasNode } from "../src/ir/types.js";
import { resolveCanvasLayout } from "../src/layout/index.js";
import {
	buildRepeatedStructures,
	editOneStructure,
	NODES_PER_STRUCTURE,
	REPEATED_STRUCTURE_COUNTS,
} from "./fixtures/repeated-structures.js";
import {
	measure,
	RUNS,
	referenceEnvironmentStatus,
	type Summary,
	spreadOf,
	WARMUP,
} from "./harness.js";
import { canvasReferenceSuiteLabel } from "./reference-suite.js";

interface Row {
	readonly structures: number;
	readonly phase: "cold" | "warm";
	readonly summary: Summary;
}

describe("repeated-structures pre-component baseline (M0-03)", () => {
	it("reports cold and warm p50/p95 for 1/10/100/500 repeated structures", () => {
		const env = referenceEnvironmentStatus();
		const rows: Row[] = [];

		for (const count of REPEATED_STRUCTURE_COUNTS) {
			const ir = buildRepeatedStructures(count);
			rows.push({
				structures: count,
				phase: "cold",
				summary: measure(() => resolveCanvasLayout(ir, {})),
			});
			// Warm = one card's title changed, re-resolve with the previous
			// resolution as cache seed — the propagation shape a component
			// Source edit will have.
			const primed = resolveCanvasLayout(ir, {});
			const edited = editOneStructure(ir);
			rows.push({
				structures: count,
				phase: "warm",
				summary: measure(() =>
					resolveCanvasLayout(edited, { previous: primed }),
				),
			});
		}

		const cpu = cpus()[0];
		console.log(
			[
				"",
				"Repeated-structures pre-component baseline (plan 0023 M0-03)",
				`  suite:       ${canvasReferenceSuiteLabel()}`,
				"  fixtures:    canvas-repeated-structures-v1[count=1,10,100,500]",
				"  resolver:    resolveCanvasLayout (pre-component — plain-node copies)",
				`  host:        ${cpu?.model ?? "unknown"} · ${cpus().length} cores · ${(totalmem() / 1024 ** 3).toFixed(1)} GB`,
				`  node:        ${process.version} · ${platform()}-${arch()}`,
				`  sampling:    ${WARMUP} warm-up + ${RUNS} samples per figure`,
				`  environment: ${env.eligible ? "MATCHES the recorded reference" : "NOT the reference"} — ${env.reason}`,
				"  role:        REFERENCE RECORD — reported, never a pass/fail signal",
				"",
				"  structures   phase   median      p95   spread",
				"  " + "-".repeat(46),
				...rows.map(
					(r) =>
						`  ${String(r.structures).padStart(10)} ${r.phase.padEnd(6)} ${r.summary.median.toFixed(3).padStart(8)} ${r.summary.p95.toFixed(3).padStart(8)} ${(spreadOf(r.summary)?.toFixed(2) ?? "n/a").padStart(7)}`,
				),
				"",
				"  Baseline record: bench/baselines/pre-component.json",
				"",
			].join("\n"),
		);

		// The harness self-test: every workload produced a real sample in both
		// phases. Latency itself is deliberately unasserted — this is the
		// reference record the M2 resolver will be judged against, not a gate.
		expect(rows).toHaveLength(REPEATED_STRUCTURE_COUNTS.length * 2);
		for (const row of rows) {
			expect(row.summary.runs, `${row.structures}/${row.phase}`).toBe(RUNS);
			expect(
				row.summary.p95,
				`${row.structures}/${row.phase} produced no timing`,
			).toBeGreaterThanOrEqual(0);
		}
	});

	it("builds the fixture shapes to spec", () => {
		// The fixtures are the measurement's independent variable; if they
		// silently shrink, every later figure improves for the wrong reason.
		const countNodes = (node: CanvasNode): number => {
			const children = (node as { children?: readonly CanvasNode[] }).children;
			return 1 + (children?.reduce((sum, c) => sum + countNodes(c), 0) ?? 0);
		};
		for (const count of REPEATED_STRUCTURE_COUNTS) {
			const ir = buildRepeatedStructures(count);
			const root = ir.pages[0]?.root as CanvasNode;
			// +1 for the page root itself.
			expect(countNodes(root), `${count} structures`).toBe(
				count * NODES_PER_STRUCTURE + 1,
			);
		}
		// Determinism: two builds of the same count are structurally identical.
		expect(buildRepeatedStructures(10)).toEqual(buildRepeatedStructures(10));
	});
});
