# canvas-core benchmarks

A dedicated Vitest project (`vitest.bench.config.ts`), excluded from
`pnpm test` so the unit suite stays fast. Single-threaded and non-isolated on
purpose: parallel workers contending for cores are exactly the noise a latency
benchmark must not measure.

## Harnesses

| Command | File | Measures |
| --- | --- | --- |
| `pnpm bench` | both files below | everything |
| `pnpm bench:layout` | `layout-resolve.bench.ts` | Auto Layout resolver vs the PRD 0014 §13.1 budgets (cold ≤ 50 ms, warm ≤ 16 ms). Gates only on the recorded reference environment. |
| `pnpm bench:components` | `repeated-structures.bench.ts` | Plan 0023 M0-03: full-document resolution of 1/10/100/500 plain-node copies of one marketing card. Report-only — the pre-component reference the M2 component resolver is compared against. |

Shared statistics, sampling discipline, and the nominated reference
environment live in `harness.ts` — both harnesses import them so their
figures stay comparable. The reference-host nomination and its tradeoffs are
documented in `REFERENCE-ENVIRONMENT.md`.

## Baselines

`baselines/pre-component.json` is the committed M0-03 record (medians + p95 of
3 consecutive pre-warmed invocations at `ANVILKIT_CANVAS_BENCH_WARMUP=25
ANVILKIT_CANVAS_BENCH_RUNS=150`). Re-measure it — same procedure, 3
consecutive runs, medians within 10% — whenever the reference environment
changes or the resolver's cost model changes intentionally.

Knobs: `ANVILKIT_CANVAS_BENCH_RUNS` (samples per figure, default 50),
`ANVILKIT_CANVAS_BENCH_WARMUP` (discarded warm-up passes, default 5),
`ANVILKIT_CANVAS_BENCH_REQUIRE_GATING=1` (fail instead of report when gating
is unavailable — CI's anti-vacuous-green flag for the layout harness).
