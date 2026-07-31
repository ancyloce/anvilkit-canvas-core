# Component libraries & brand governance: entry layout, budgets, and measured performance

Decision record for plan 0021 T-051 / T-052. Measured 2026-07-30 against
`@anvilkit/canvas-core` at M5.

## 1. Entry layout

`@anvilkit/canvas-core` ships four entries. The split is a cost decision, not a
taxonomy: each subpath exists so a host that does not use a capability does not
pay for it.

| Entry | Budget | Measured (gzip) | Of budget | What it carries |
| --- | ---: | ---: | ---: | --- |
| `@anvilkit/canvas-core` | 80 KB | 57,882 B | 70.7% | IR, commands, geometry, resolver, serialization |
| `@anvilkit/canvas-core/component-libraries` | 24 KB | 16,789 B | 68.3% | Admission, canonicalization, integrity, closure, compatibility, library commands |
| `@anvilkit/canvas-core/brand-governance` | 12 KB | 4,960 B | 40.4% | Policy contracts, command gateway, compliance engine + cache, audit envelope |
| `@anvilkit/canvas-core/export-preparation` | 16 KB | 10,711 B | 65.4% | `prepareExport` and the resolver it needs |

Raw bytes are reported by `scripts/check-bundle-budget.mjs`, which bundles each
entry with esbuild and measures the gzipped entry chunk. `zod` and `pdf-lib` are
excluded as declared peers.

### 1.1 Why `export-preparation` is a separate entry

It was not, initially, and the measurement is why it is now.

`prepareExport` resolves every component Source and validates the graph, so it
pulls the entire rank-2 resolver — `components/validate.ts`,
`components/snapshot-index.ts`, `components/definition-lookup.ts` — into
whatever entry contains it. With it inside `/brand-governance`, that entry
measured **12,281 B against a 12,288 B budget: 99.9%, seven bytes of headroom**.

Two options existed. Raise the 12 KB limit, or fix the packaging. Raising it
would have recorded a bigger number and hidden the actual fact, which is that a
host enforcing brand policy at command time — the common case, and precisely
the case the subpath was created to serve cheaply — was being made to carry an
export pipeline it never calls.

Splitting restored `/brand-governance` to **4,960 B (40.4%)** and gave the
export pipeline a budget that reflects its real cost. No budget was weakened.

### 1.2 What stays on the root barrel

Types only, for the governance and library domains. `CanvasBrandComponentPolicy`
and the component-source types are persisted IR shapes and are re-exported from
the root as **types**, which are erased at build time. Values — evaluators,
scanners, caches, admission — stay in their subpaths. This is what keeps the
80 KB root budget flat across the whole of plan 0021: it measured 70.3% at M4
and 70.7% at M5, and the 0.4-point change is the new `ir/` shapes, not the
engines.

## 2. Measured performance (NFR §14.1)

Measured by `src/component-libraries/__tests__/perf.test.ts` on the development
box (WSL2, shared machine, background IDE server) — **not** a pinned reference
environment. Fixture: 500 component instances in a 1,000-node document, 16
exposed properties per definition.

| Budget (PRD §14.1) | Target | Measured (median) | Headroom |
| --- | ---: | ---: | ---: |
| Compliance scan, 1,000 nodes / 500 instances | p95 ≤ 100 ms | **2.0 ms** | 50× |
| Cached insertion → resolved render | p95 ≤ 100 ms | **0.1 ms** | 1000× |
| Update comparison + 500 override migrations | p95 ≤ 250 ms | **7.4 ms** | 34× |
| Library first-page UI response | p95 ≤ 1.5 s | not measured | — |

The fourth budget is excluded by construction: it is dominated by Provider
latency, which the PRD itself excludes ("excluding provider SLA violations"),
and the remaining editor-side work is a React render that a Node benchmark
cannot observe meaningfully. The related requirement that *loading feedback
appears within 100 ms* is a behavioural property and is covered by the
provider-request-store tests (T-018/T-019), not by a timer.

### 2.1 How the assertions are written, and why

The tests assert at **8× the PRD target** and print the measured value. This is
deliberate and is not a weakened budget:

- The PRD's numbers are p95 on an *agreed reference environment*. This box is
  not one. An assertion at 100 ms here would measure machine load and fail for
  reasons no one could act on — the fastest route to a disabled test.
- What a test on an unpinned machine *can* do reliably is catch an algorithmic
  regression. An accidental O(n²) or a cache that stopped hitting changes the
  number by an order of magnitude, not by 30%, and clears an 8× margin easily.
- A fourth test asserts the **shape of the curve** rather than a duration: a 4×
  larger document must not cost more than 10× the time. Measured: **3.1×**.

All four budgets are in fact met outright on this machine, with 34–1000×
headroom. The margin is an environment allowance, not slack that has been used.

A true p95 gate belongs in the perf CI harness with a pinned runner. That is
recorded as an open follow-up on the M5 ledger.
