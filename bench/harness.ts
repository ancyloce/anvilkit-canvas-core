/**
 * @file Shared measurement harness for the canvas-core benchmarks.
 *
 * Extracted from `layout-resolve.bench.ts` when the plan 0023 M0-03
 * repeated-structures baseline became the second consumer: the statistics and
 * the reference-environment record MUST be shared, not copied — two harnesses
 * with subtly different p95 math or host fingerprints produce figures that
 * cannot be compared, and comparability is the entire point of a baseline.
 */

import { arch, cpus, platform, release } from "node:os";
import { performance } from "node:perf_hooks";

/**
 * Sample count per measurement. Recorded in REFERENCE-ENVIRONMENT.md and
 * raised from 20 to 50 when the WSL2 host was nominated as the reference
 * (OQ-1): a p95 over 20 samples on a scheduler-noisy host is the 19th of 20
 * observations, so one descheduled run moves it. 50 samples make the tail
 * statistic mean something.
 */
export const RUNS = Number(process.env.ANVILKIT_CANVAS_BENCH_RUNS ?? "50");

/**
 * Warm-up passes discarded before sampling. Raised from 2 to 5 alongside RUNS
 * so JIT tiering has settled before the first recorded sample.
 */
export const WARMUP = Number(process.env.ANVILKIT_CANVAS_BENCH_WARMUP ?? "5");

/**
 * Largest p95/median ratio a run may show and still be considered stable
 * enough to gate on. A tight loop should sit near 1.0; a heavily descheduled
 * one blows past 2. Reported always, enforced only when gating is enabled.
 */
export const MAX_STABLE_SPREAD = 2.5;

/**
 * Median below which the spread ratio is meaningless and is neither reported
 * nor enforced.
 *
 * `performance.now()` resolution and per-iteration overhead dominate at
 * sub-microsecond medians, so p95/median there measures the CLOCK, not the
 * code: the stub's warm path medians at 0.000 ms and "spreads" at 3.6, which
 * would fail a stability gate while being perfectly stable. Only measurements
 * comfortably above timer granularity get a stability verdict.
 */
export const MIN_SPREAD_MEANINGFUL_MS = 0.5;

export interface Summary {
	readonly median: number;
	readonly p95: number;
	readonly runs: number;
}

/**
 * Nearest-rank p95 over a sorted copy.
 *
 * Deliberately re-implemented rather than imported: the equivalent helper
 * lives in `@anvilkit/core`, which `canvas-core` must not depend on — the
 * package is headless and its `check:peer-deps` gate asserts a React/Konva-free
 * dependency cone. The algorithm matches that helper so figures from the two
 * harnesses stay comparable.
 */
export function summarize(samples: readonly number[]): Summary {
	if (samples.length === 0) return { median: 0, p95: 0, runs: 0 };
	const sorted = [...samples].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0
			? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
			: (sorted[mid] as number);
	const rank = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * 0.95) - 1),
	);
	return { median, p95: sorted[rank] as number, runs: sorted.length };
}

/**
 * p95 / median — a scale-free stability indicator. Near 1.0 means the samples
 * are tightly clustered; a large value means the tail is dominated by
 * scheduling noise rather than by the code under test.
 */
export function spreadOf(summary: Summary): number | null {
	if (summary.median < MIN_SPREAD_MEANINGFUL_MS) return null;
	return summary.p95 / summary.median;
}

export function measure(run: () => unknown): Summary {
	for (let i = 0; i < WARMUP; i += 1) run();
	const samples: number[] = [];
	for (let i = 0; i < RUNS; i += 1) {
		const started = performance.now();
		run();
		samples.push(performance.now() - started);
	}
	return summarize(samples);
}

/**
 * The NOMINATED performance reference environment (OQ-1, closed 2026-07-27).
 *
 * This is the host the p95 targets are defined against. It is deliberately a
 * data record compared at runtime, not a "not-WSL2" heuristic: the previous
 * version refused to gate on any WSL2 kernel, which made the targets
 * unfalsifiable everywhere because no other machine had been nominated
 * either. A recorded fingerprint can at least be matched, and a mismatch can
 * be reported precisely.
 *
 * **This nomination overrides PRD §6.3's blanket disqualification of the WSL2
 * development host.** See `bench/REFERENCE-ENVIRONMENT.md` for the tradeoff
 * that acceptance carries and the sampling discipline that compensates for
 * it. Changing machines means editing this record and re-measuring the
 * baseline — the figures are not portable across hosts.
 */
export const REFERENCE_ENVIRONMENT = {
	cpuModel: "Intel(R) Core(TM) i5-10300H CPU @ 2.50GHz",
	logicalCores: 8,
	platform: "linux",
	arch: "x64",
	/** Kernel family, not the exact patch release — patch bumps must not un-nominate the host. */
	kernelPattern: /microsoft-standard-WSL2/,
	/** Major only; a minor/patch Node bump does not invalidate the nomination. */
	nodeMajor: 24,
} as const;

/**
 * Whether this host may produce gating numbers.
 *
 * Gating requires an EXACT match against the recorded reference above. An
 * unrecognised host still runs and still reports — it just cannot produce a
 * pass/fail signal, because a target measured on one machine says nothing
 * about another.
 */
export function referenceEnvironmentStatus(): {
	readonly eligible: boolean;
	readonly reason: string;
} {
	const cpu = cpus()[0]?.model ?? "unknown";
	const mismatches: string[] = [];
	if (cpu !== REFERENCE_ENVIRONMENT.cpuModel) {
		mismatches.push(`cpu "${cpu}" != "${REFERENCE_ENVIRONMENT.cpuModel}"`);
	}
	if (cpus().length !== REFERENCE_ENVIRONMENT.logicalCores) {
		mismatches.push(
			`cores ${cpus().length} != ${REFERENCE_ENVIRONMENT.logicalCores}`,
		);
	}
	if (platform() !== REFERENCE_ENVIRONMENT.platform) {
		mismatches.push(
			`platform ${platform()} != ${REFERENCE_ENVIRONMENT.platform}`,
		);
	}
	if (arch() !== REFERENCE_ENVIRONMENT.arch) {
		mismatches.push(`arch ${arch()} != ${REFERENCE_ENVIRONMENT.arch}`);
	}
	if (!REFERENCE_ENVIRONMENT.kernelPattern.test(release())) {
		mismatches.push(`kernel "${release()}" is not the recorded family`);
	}
	const nodeMajor = Number(process.version.replace(/^v/, "").split(".")[0]);
	if (nodeMajor !== REFERENCE_ENVIRONMENT.nodeMajor) {
		mismatches.push(
			`node major ${nodeMajor} != ${REFERENCE_ENVIRONMENT.nodeMajor}`,
		);
	}
	if (mismatches.length > 0) {
		return {
			eligible: false,
			reason: `not the recorded reference environment (${mismatches.join("; ")})`,
		};
	}
	return {
		eligible: true,
		reason: `recorded reference environment (${REFERENCE_ENVIRONMENT.cpuModel}, ${REFERENCE_ENVIRONMENT.logicalCores} cores, node ${REFERENCE_ENVIRONMENT.nodeMajor}.x)`,
	};
}
