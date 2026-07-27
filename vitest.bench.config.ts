import { defineConfig } from "vitest/config";

/**
 * The Auto Layout benchmark project (plan 0022, T-M0-07).
 *
 * Kept out of `pnpm test` on purpose: the harness builds 1,000-node fixtures
 * and runs every workload 20 times in both phases, which must not be paid on
 * every unit-test run. `*.bench.ts` under `bench/` also does not match the
 * unit project's `src/**` include, so the two can never pick up each other's
 * files by accident.
 *
 * Deliberately **not** built with `mergeConfig(nodePreset, …)`: `mergeConfig`
 * concatenates arrays, so the preset's `include` would be unioned with this
 * one and the bench project would run the entire unit suite.
 *
 * `environment: "node"` because every workload is plain-object arithmetic.
 * Single-threaded and non-isolated: parallel workers contending for the same
 * cores are exactly the noise a latency benchmark must not measure.
 */
export default defineConfig({
	test: {
		name: "@anvilkit/canvas-core:bench",
		include: ["bench/**/*.bench.ts"],
		environment: "node",
		isolate: false,
		fileParallelism: false,
		pool: "threads",
		maxWorkers: 1,
		minWorkers: 1,
		// The harness prints its own table; Vitest's console interception would
		// swallow it on a passing run — the run whose numbers people want.
		disableConsoleIntercept: true,
		testTimeout: 900_000,
		hookTimeout: 900_000,
	},
});
