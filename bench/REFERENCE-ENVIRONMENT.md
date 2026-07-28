# Auto Layout — Performance Reference Environment

Companion record for `bench/layout-resolve.bench.ts`, required by
plan 0022 T-M0-07 (PRD 0014 §6.3, §13.1; Technical Design §15.1).

## Why this file gates the targets

PRD §13.1 states p95 **≤ 50 ms cold** and **≤ 16 ms warm** "on the reference
environment". Those numbers mean nothing until the environment is written
down: the same resolver is fast or slow depending entirely on the machine, so
without this record a regression cannot be attributed to code rather than to
hardware.

## Status: CLOSED — reference environment nominated 2026-07-27

**OQ-1 is answered.** The current development host is the recorded reference
environment, by explicit maintainer decision.

| Field | Value |
| --- | --- |
| CPU model | `Intel(R) Core(TM) i5-10300H CPU @ 2.50GHz` |
| Physical / logical cores | 4 physical / **8 logical** (2 threads per core, 1 socket) |
| RAM | 23.5 GB (+16 GB swap) |
| OS + kernel | Linux `5.15.167.4-microsoft-standard-WSL2`, x86_64 |
| Node version | `v24.18.0` (major **24**) |
| Package manager | pnpm 11.17.0 |
| Headless | yes — the harness is pure Node, no browser or renderer |
| Warm-up passes | **5** (`ANVILKIT_CANVAS_BENCH_WARMUP`) |
| Samples per figure | **50** (`ANVILKIT_CANVAS_BENCH_RUNS`) |
| Stability limit | p95/median ≤ **2.5**, applied only to medians ≥ 0.5 ms |
| Recorded by / date | Canvas maintainer decision, 2026-07-27 |

The harness holds this same fingerprint as `REFERENCE_ENVIRONMENT` and compares
the running host against it at runtime. A mismatch is reported field by field
("cpu X != Y", "cores 4 != 8", …) and disables gating — it does not stop the
run, because reporting on a non-reference machine is still useful.

## This nomination overrides PRD §6.3 — read this before trusting a number

PRD §6.3 disqualifies a WSL2 host as a reference environment because its
timing variance is too high to gate on. **That concern was not withdrawn; it
was accepted as a tradeoff.** Recorded plainly so nobody later reads a green
benchmark as stronger evidence than it is:

- **Scheduling noise is real.** WSL2 runs under a Hyper-V utility VM sharing
  cores with the Windows host. A background compile or a browser on the
  Windows side lands in these samples.
- **No CPU frequency control.** `scaling_governor` is not exposed under WSL2,
  so turbo/thermal behaviour cannot be pinned. An i5-10300H is a laptop part
  that throttles under sustained load; a warm machine measures differently
  from a cold one.
- **The figures are not portable.** They characterise *this* laptop. They are
  a regression tripwire for this machine, not a statement about end users'
  hardware.

What was done to make the host as trustworthy as it can be, rather than just
declaring it fine:

1. **Sampling raised** from 20→**50** samples and 2→**5** warm-up passes. A p95
   over 20 samples is the 19th observation, so a single descheduled run moves
   it; 50 samples make the tail statistic mean something.
2. **A stability metric gates before latency.** Every figure reports
   `spread` = p95/median. When gating is enabled, a spread above 2.5 fails the
   run *as too noisy* before any latency comparison — so a bad number is
   reported as untrustworthy rather than being silently attributed to code.
3. **The spread metric has a relevance floor.** Below a 0.5 ms median,
   `performance.now()` resolution dominates the ratio, so it is reported `n/a`
   and not enforced. Without this the stub's 0.000 ms warm path "spreads" at
   3.6 and would fail a stability gate while being perfectly stable.

**Operating requirement for any run whose numbers will be quoted:** an
otherwise-idle machine — no dev server, no test watcher, no build, and
nothing heavy running on the Windows side. Re-run any figure whose spread
looks anomalous before acting on it.

Per plan assumption A-4, golden and browser regression baselines are still
generated on CI hardware, not here — this nomination covers the **headless
Core resolver benchmark only**, which is the one thing §13.1's targets are
about.

## Cold and warm are separate statistics

They are never averaged into one figure:

- **Cold** — the first resolution after mount, with no runtime cache. The
  subtree cache is session-scoped and does not survive a reload, so cold is
  always a full pass. Target: p95 ≤ 50 ms.
- **Warm** — a subsequent resolution with a valid subtree cache. Target:
  p95 ≤ 16 ms.

Conflating them made the 16 ms target unachievable by construction on first
load, which is why the harness reports two rows per workload.

## Workloads (Technical Design §15.1)

Measured by the harness:

| Workload | Shape |
| --- | --- |
| `1k-nodes-30pct-frames` | 1,000 nodes, 30% frames, depth ≤ 10 |
| `100-text-20-keys` | 100 text nodes sharing 20 measurement keys |
| `hug-chain-depth-3` | three-level Hug chain, for edit invalidation |

Named in §15.1 but **not** measured here, because neither is a Core-resolver
metric and a Node figure for them would be fiction:

- *drag-resize preview at pointer frequency* — requires a real renderer and
  belongs to the editor's browser harness.
- *full SVG export after cold load* — a serializer-level path, measurable only
  once the resolved-document option lands in M3.

## Baseline reading (stub resolver, 2026-07-27)

Recorded on the machine above so the M2 handover has a "before". **These are
the harness's own overhead, not the resolver's cost** — `layout/` has no
solver yet, so the stub only walks the tree.

| Workload | Phase | median (ms) | p95 (ms) | spread |
| --- | --- | --- | --- | --- |
| `1k-nodes-30pct-frames` | cold | 0.059 | 0.109 | n/a |
| `1k-nodes-30pct-frames` | warm | 0.000 | 0.002 | n/a |
| `100-text-20-keys` | cold | 0.005 | 0.034 | n/a |
| `100-text-20-keys` | warm | 0.000 | 0.001 | n/a |
| `hug-chain-depth-3` | cold | 0.001 | 0.002 | n/a |
| `hug-chain-depth-3` | warm | 0.000 | 0.000 | n/a |

Every spread is `n/a` because every median is far below the 0.5 ms relevance
floor. Expect the 1k-node cold row to be the first to produce a real spread
once the M2 resolver lands.

## M2 baseline — the REAL resolver (2026-07-27, plan 0022 T-M2-11)

`resolveCanvasLayout` has landed, so both gating conditions are now satisfied
and **these figures are a pass/fail signal on this host.**

Three consecutive runs, otherwise-idle machine:

| Workload | Phase | Median (ms) | p95 (ms) | Spread | Target |
| --- | --- | --- | --- | --- | --- |
| `1k-nodes-30pct-frames` | cold | 5.02 / 5.28 / 5.83 | 10.38 / 11.27 / 12.23 | 2.07 / 2.14 / 2.10 | 50 ms |
| `1k-nodes-30pct-frames` | warm | 2.35 / 2.49 / 2.30 | 4.22 / 5.06 / 5.36 | 1.80 / 2.03 / 2.33 | 16 ms |
| `100-text-20-keys` | cold | 0.52 | 1.04 | 2.00 | 50 ms |
| `100-text-20-keys` | warm | 0.35 | 0.55 | n/a | 16 ms |
| `hug-chain-depth-3` | cold | 0.04 | 0.11 | n/a | 50 ms |
| `hug-chain-depth-3` | warm | 0.04 | 0.14 | n/a | 16 ms |

**Verdict: both targets met with ~4x headroom cold and ~3x warm.**

### A false green found and fixed while recording this

The first M2 run reported warm 6.150 ms against cold 5.651 ms — statistically
indistinguishable, and passing the 16 ms budget purely by accident. The cause
was in this harness, not the resolver: the M0 stub had no cache, so
`resolveWarm` ignored its `previous` argument and simply re-resolved. Against
the real resolver that measures a **second cold pass** and labels it warm.

The warm path now threads `previous` into the resolver and each workload
defines the localized edit TD §15.1 calls for, so the warm figure measures
"re-resolve after one small change with a valid subtree cache". Warm is now
**~2.1x faster than cold** on the 1k-node workload, which is the cache doing
its job rather than a label doing it.

### Residual caution

Spreads on the 1k-node rows sit at **2.0–2.3 against a 2.5 limit** — real
headroom, but not much. A run on a busy machine will trip the stability gate
before it trips a latency budget, which is the intended order: a figure too
noisy to trust fails as noisy rather than passing or failing on latency by
luck. Quote a run only from an otherwise-idle host.

## Running it

```sh
pnpm --filter @anvilkit/canvas-core bench:layout
```

Environment overrides: `ANVILKIT_CANVAS_BENCH_RUNS`,
`ANVILKIT_CANVAS_BENCH_WARMUP`.

## What the harness will and will not do

Gating requires **both** conditions; the run prints which one is missing.

1. **A real resolver.** `layout/` gained its solver in M2. **Satisfied as of
   2026-07-27** — `loadResolver()` dynamically imports `../src/layout/index.js`
   and switched to its `resolveCanvasLayout` export as soon as that module
   existed, so gating turned on by itself.
2. **The recorded reference environment.** Satisfied on the machine above as
   of this nomination.

Both hold, so **gating is ENABLED** and the p95 targets are enforced — which is
exactly what closing OQ-1 was for. Probe-verified: tightening `TARGET_COLD_MS`
to 1 fails the run with `1k-nodes-30pct-frames/cold p95 exceeds the PRD §13.1
budget`, and restoring it returns the suite to 2/2.

## Changing the reference machine

Edit `REFERENCE_ENVIRONMENT` in `bench/layout-resolve.bench.ts` **and** the
table at the top of this file in the same change, then re-measure the baseline
above. The figures do not transfer between hosts; a machine change invalidates
every recorded number, not just the fingerprint.
