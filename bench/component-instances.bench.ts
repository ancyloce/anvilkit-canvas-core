/**
 * @file Component-resolution performance vs. the M0-03 pre-component baseline
 * (plan 0023 M6-04, NFR-001).
 *
 * Run with `pnpm bench:instances` (or `pnpm bench` for every harness).
 *
 * Measures the SAME documents the M0-03 baseline measured — the PRD §2 marketing
 * card, 1/10/100/500 of them — but built as one Component Source plus N
 * instances and resolved through the composed `resolveCanvasDocument`. Reporting
 * both figures side by side is what makes NFR-001 ("100 instances p95 ≤ 100 ms")
 * falsifiable rather than asserted: the number that matters is the DELTA against
 * the plain-node record in `bench/baselines/pre-component.json`.
 *
 * Report-only for latency, exactly like the baseline harness: this host is a
 * WSL2 laptop, so absolute milliseconds are not a gate. What IS asserted here is
 * the invalidation SHAPE (T-PERF-1) — that is deterministic and host-independent.
 */

import { arch, cpus, platform, totalmem } from "node:os";
import { describe, expect, it } from "vitest";
import { createComponentResolutionCache } from "../src/components/cache.js";
import { buildComponentGraph } from "../src/components/graph.js";
import type { CanvasNode } from "../src/ir/types.js";
import { resolveCanvasDocument } from "../src/layout/resolve-document.js";
import baseline from "./baselines/pre-component.json" with { type: "json" };
import {
	buildComponentInstances,
	COMPONENT_INSTANCE_COUNTS,
	editComponentSource,
	overrideOneInstance,
} from "./fixtures/component-instances.js";
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
	readonly instances: number;
	readonly phase: "cold" | "warm-override" | "warm-source";
	readonly summary: Summary;
}

/** The recorded plain-node figure for `count`, for the side-by-side column. */
function baselineFor(
	count: number,
	phase: "cold" | "warm",
): { medianMs: number; p95Ms: number } | undefined {
	const workload = (
		baseline as {
			workloads: ReadonlyArray<{
				structures: number;
				cold: { medianMs: number; p95Ms: number };
				warm: { medianMs: number; p95Ms: number };
			}>;
		}
	).workloads.find((w) => w.structures === count);
	return workload?.[phase];
}

describe("component-instance resolution vs the pre-component baseline (M6-04)", () => {
	it("reports cold and warm p50/p95 for 1/10/100/500 instances", () => {
		const env = referenceEnvironmentStatus();
		const rows: Row[] = [];

		for (const count of COMPONENT_INSTANCE_COUNTS) {
			const ir = buildComponentInstances(count);
			rows.push({
				instances: count,
				phase: "cold",
				summary: measure(() => resolveCanvasDocument(ir, {})),
			});

			// Warm #1 — ONE instance gains an override. The propagation shape the
			// M0-03 warm figure measured (one card's title edited).
			const primed = resolveCanvasDocument(ir, {});
			const overridden = overrideOneInstance(ir);
			rows.push({
				instances: count,
				phase: "warm-override",
				summary: measure(() =>
					resolveCanvasDocument(overridden, { previous: primed }),
				),
			});

			// Warm #2 — the SOURCE changes, so every instance must re-resolve. This
			// has no pre-component counterpart at all: editing N copies meant N
			// document writes, where a component edit is one Registry write.
			const sourceEdited = editComponentSource(ir);
			rows.push({
				instances: count,
				phase: "warm-source",
				summary: measure(() =>
					resolveCanvasDocument(sourceEdited, { previous: primed }),
				),
			});
		}

		const cpu = cpus()[0];
		console.log(
			[
				"",
				"Component-instance resolution vs pre-component baseline (plan 0023 M6-04)",
				`  suite:       ${canvasReferenceSuiteLabel()}`,
				"  fixtures:    canvas-component-instances-v1[count=1,10,100,500]",
				"  resolver:    resolveCanvasDocument (component expansion → Auto Layout)",
				`  host:        ${cpu?.model ?? "unknown"} · ${cpus().length} cores · ${(totalmem() / 1024 ** 3).toFixed(1)} GB`,
				`  node:        ${process.version} · ${platform()}-${arch()}`,
				`  sampling:    ${WARMUP} warm-up + ${RUNS} samples per figure`,
				`  environment: ${env.eligible ? "MATCHES the recorded reference" : "NOT the reference"} — ${env.reason}`,
				"  role:        REPORTED against bench/baselines/pre-component.json",
				"",
				"   instances   phase           median      p95   spread   baseline(median/p95)",
				"  " + "-".repeat(76),
				...rows.map((r) => {
					const base =
						r.phase === "cold"
							? baselineFor(r.instances, "cold")
							: r.phase === "warm-override"
								? baselineFor(r.instances, "warm")
								: undefined;
					const baseText = base
						? `${base.medianMs.toFixed(3)} / ${base.p95Ms.toFixed(3)}`
						: "no plain-node counterpart";
					return `  ${String(r.instances).padStart(10)} ${r.phase.padEnd(14)} ${r.summary.median.toFixed(3).padStart(8)} ${r.summary.p95.toFixed(3).padStart(8)} ${(spreadOf(r.summary)?.toFixed(2) ?? "n/a").padStart(7)}   ${baseText}`;
				}),
				"",
				`  NFR-001 reference: 100 instances cold p95 = ${rows.find((r) => r.instances === 100 && r.phase === "cold")?.summary.p95.toFixed(3) ?? "n/a"} ms (target ≤ 100 ms, provisional)`,
				"",
			].join("\n"),
		);

		// Harness self-test only — latency is reported, never gated, on this host.
		expect(rows).toHaveLength(COMPONENT_INSTANCE_COUNTS.length * 3);
		for (const row of rows) {
			expect(row.summary.runs, `${row.instances}/${row.phase}`).toBe(RUNS);
			expect(
				row.summary.p95,
				`${row.instances}/${row.phase} produced no timing`,
			).toBeGreaterThanOrEqual(0);
		}
	});

	it("resolves every instance as a DISTINCT record at every count", () => {
		// The measurement's independent variable: if instances silently collapse
		// (as they did before the M6-03 cache-key fix), every figure below
		// improves for the worst possible reason.
		for (const count of COMPONENT_INSTANCE_COUNTS) {
			const resolved = resolveCanvasDocument(
				buildComponentInstances(count),
				{},
			);
			expect(resolved.componentIssues, `${count} instances`).toEqual([]);
			// 6 nodes per card + 1 page root, mirroring NODES_PER_STRUCTURE.
			expect(resolved.records.size, `${count} instances`).toBe(count * 6 + 1);
		}
	});

	it("T-PERF-1: one override edit invalidates ONLY that instance", () => {
		const ir = buildComponentInstances(100);
		const cache = createComponentResolutionCache();
		resolveCanvasDocument(ir, { componentCache: cache });
		const primed = cache.stats().instance;
		// One entry per instance — the M6-03 fix is what makes this 100 and not 1.
		expect(primed).toBe(100);

		// An override changes ONE instance's cache key, so exactly one entry is
		// added; the other 99 keys are untouched and still hit.
		resolveCanvasDocument(overrideOneInstance(ir), { componentCache: cache });
		expect(cache.stats().instance).toBe(primed + 1);
	});

	it("T-PERF-1: a SOURCE edit invalidates every dependent instance, and nothing else", () => {
		const ir = buildComponentInstances(10);
		const cache = createComponentResolutionCache();
		resolveCanvasDocument(ir, { componentCache: cache });
		expect(cache.stats().instance).toBe(10);

		// The documented invalidation entry point: a Source edit drops the
		// component AND its transitive dependents.
		const edited = editComponentSource(ir);
		cache.invalidateComponent(
			"cmp-card",
			buildComponentGraph(edited.components ?? {}),
		);
		expect(cache.stats().instance).toBe(0);

		// Re-resolving repopulates all ten with the NEW content — one Registry
		// write propagated to every instance without touching an instance node.
		const resolved = resolveCanvasDocument(edited, { componentCache: cache });
		expect(cache.stats().instance).toBe(10);
		const titles = [...resolved.records.values()]
			.map((r) => (r.node as { text?: string }).text)
			.filter((t): t is string => t !== undefined);
		expect(titles.filter((t) => t === "Edited title")).toHaveLength(10);
		expect(titles).not.toContain("Summer sale");
	});

	it("builds the instance fixture to the same shape as the plain one", () => {
		const countNodes = (node: CanvasNode): number => {
			const children = (node as { children?: readonly CanvasNode[] }).children;
			return 1 + (children?.reduce((sum, c) => sum + countNodes(c), 0) ?? 0);
		};
		for (const count of COMPONENT_INSTANCE_COUNTS) {
			const ir = buildComponentInstances(count);
			// PERSISTED size is one node per instance plus the root — the whole point
			// of components: N instances cost N nodes, not N × 6.
			expect(countNodes(ir.pages[0]?.root as CanvasNode), `${count}`).toBe(
				count + 1,
			);
		}
		// Determinism: two builds of the same count are structurally identical.
		expect(buildComponentInstances(10)).toEqual(buildComponentInstances(10));
	});
});
