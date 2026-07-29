/**
 * @file Auto Layout resolver benchmark harness (plan 0022, T-M0-07).
 *
 * Run with `pnpm bench:layout` — a dedicated Vitest project, excluded from
 * `pnpm test` so the unit suite stays fast.
 *
 * ### Why this exists at M0, before the resolver
 *
 * PRD §6.3 and §13.1 quote p95 ≤ 50 ms cold and ≤ 16 ms warm "on the
 * reference environment". Until that environment is written down those
 * numbers are unfalsifiable, so recording it is an M0 deliverable rather
 * than a release-time checkbox (TD §15.1). This harness is the other half:
 * it fixes *how* the numbers are produced, so the M2 resolver is measured
 * by an instrument that already existed rather than one written to fit it.
 *
 * ### Cold and warm are separate measurements
 *
 * Cold is the first resolution after mount with no runtime cache — the
 * subtree cache is session-scoped and does not survive a reload — and is
 * always a full pass. Warm is a subsequent resolution with a valid subtree
 * cache. A single conflated figure made the 16 ms target unachievable by
 * construction on first load, so the two are never averaged together here.
 *
 * ### When this harness gates
 *
 * Two conditions must BOTH hold, and the run prints which one is missing:
 *
 * 1. **A real resolver.** `layout/` lands in M2. Until then this runs against
 *    a stub, and a stub meeting a latency budget proves nothing.
 * 2. **The recorded reference environment.** OQ-1 was closed on 2026-07-27 by
 *    nominating this repository's development host; `REFERENCE_ENVIRONMENT`
 *    in `harness.ts` is that record, and gating requires an exact match
 *    against it.
 *
 * Condition 2 is now satisfiable, condition 1 is not — so this still reports
 * rather than gates, and says so. Printing a number that was never a pass/fail
 * signal, and saying so, is the point.
 *
 * Because the nominated host is a WSL2 machine (see REFERENCE-ENVIRONMENT.md
 * for why that was accepted), every figure carries a `spread` = p95/median.
 * Scheduling noise shows up there first, so a run whose numbers cannot be
 * trusted is visible rather than silently authoritative.
 *
 * ### Swapping in the real resolver (M2 — done)
 *
 * `loadResolver()` dynamically imports `../src/layout/index.js` and uses its
 * `resolveCanvasLayout` export when present, falling back to the stub when it
 * is not. That much needed no edit.
 *
 * What DID need an edit was the warm path. The M0 stub had no cache, so
 * `resolveWarm` ignored its `previous` argument and simply re-resolved — which
 * against the real resolver measures a **second cold pass** and reports it as
 * warm. It passed the 16 ms budget by accident rather than because the cache
 * worked (measured: warm 6.150 ms vs cold 5.651 ms — indistinguishable). The
 * warm path now threads `previous` into the resolver, and each workload
 * defines the localized edit TD §15.1 calls for, so the warm figure measures
 * "re-resolve after one small change with a valid subtree cache" — which is
 * what the ≤16 ms target is actually about.
 */

import { arch, cpus, platform, totalmem } from "node:os";
import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createFrame,
	createPage,
	createRect,
	createText,
} from "../src/ir/builders.js";
import { insertNode, updateNode } from "../src/ir/mutations.js";
import type { CanvasIR, CanvasNode } from "../src/ir/types.js";
import {
	MAX_STABLE_SPREAD,
	measure,
	RUNS,
	referenceEnvironmentStatus,
	type Summary,
	spreadOf,
	WARMUP,
} from "./harness.js";

/** PRD §13.1 targets, in milliseconds. Reported, never enforced here. */
const TARGET_COLD_MS = 50;
const TARGET_WARM_MS = 16;

/** The resolver under test, plus whether it is the real one. */
interface ResolverUnderBench {
	readonly id: string;
	readonly isStub: boolean;
	/** Full resolution with no cache — the "cold" path. */
	readonly resolveCold: (ir: CanvasIR) => unknown;
	/** Resolution reusing a prior result — the "warm" path. */
	readonly resolveWarm: (ir: CanvasIR, previous: unknown) => unknown;
}

/**
 * A placeholder that walks the document the way a resolver must.
 *
 * It exists so the harness — fixture generation, sampling, reporting — is
 * exercised end to end before `layout/` lands, NOT to stand in for the
 * resolver's cost. Every reported figure carries `isStub`, and gating is
 * refused while it is true.
 */
function createStubResolver(): ResolverUnderBench {
	const walk = (node: CanvasNode, depth: number): number => {
		let count = 1;
		const children = (node as { children?: readonly CanvasNode[] }).children;
		if (children) {
			for (const child of children) count += walk(child, depth + 1);
		}
		return count;
	};
	return {
		id: "stub",
		isStub: true,
		resolveCold: (ir) =>
			ir.pages.reduce((total, page) => total + walk(page.root, 0), 0),
		resolveWarm: (_ir, previous) => previous,
	};
}

async function loadResolver(): Promise<ResolverUnderBench> {
	try {
		// M2 seam: present only once `src/layout/` ships. The dynamic specifier
		// keeps this file compiling (and this harness runnable) before then.
		const mod = (await import(
			/* @vite-ignore */ "../src/layout/index.js"
		)) as Record<string, unknown>;
		const resolve = mod.resolveCanvasLayout as
			| ((ir: CanvasIR, options: Record<string, unknown>) => unknown)
			| undefined;
		if (typeof resolve === "function") {
			return {
				id: "resolveCanvasLayout",
				isStub: false,
				resolveCold: (ir) => resolve(ir, {}),
				// Threading `previous` is what makes this the WARM path. Without
				// it this is a second cold pass wearing a warm label.
				resolveWarm: (ir, previous) => resolve(ir, { previous }),
			};
		}
	} catch {
		// Not built yet — expected until M2.
	}
	return createStubResolver();
}

/**
 * TD §15.1 workload 1: 1,000 nodes, 30% frames, depth ≤ 10.
 *
 * Built breadth-first with a depth cap so the shape is reproducible: a
 * randomly-shaped tree would make run-to-run figures incomparable, which is
 * the opposite of what a latency baseline needs.
 */
function buildLargeDocument(nodeCount = 1_000, frameRatio = 0.3): CanvasIR {
	const page = createPage({ id: "bench-page" });
	let ir = createCanvasIR({ id: "bench", title: "bench", pages: [page] });
	const containers: { id: string; depth: number }[] = [
		{ id: page.root.id, depth: 0 },
	];
	const MAX_DEPTH = 10;

	for (let i = 0; i < nodeCount; i += 1) {
		// Round-robin over open containers keeps the tree wide and shallow
		// rather than degenerating into a single deep spine.
		const parent = containers[i % containers.length] as {
			id: string;
			depth: number;
		};
		const makeFrame = i % Math.round(1 / frameRatio) === 0;
		const bounds = { width: 100, height: 40 };
		if (makeFrame && parent.depth < MAX_DEPTH) {
			const frame = createFrame({ id: `f${i}`, bounds });
			ir = insertNode(ir, { parentId: parent.id, node: frame });
			containers.push({ id: frame.id, depth: parent.depth + 1 });
		} else {
			ir = insertNode(ir, {
				parentId: parent.id,
				node: createRect({ id: `r${i}`, bounds }),
			});
		}
	}
	return ir;
}

/** TD §15.1 workload 2: 100 text nodes sharing 20 measurement keys. */
function buildTextDocument(textCount = 100, distinctKeys = 20): CanvasIR {
	const page = createPage({ id: "text-page" });
	let ir = createCanvasIR({ id: "text", title: "text", pages: [page] });
	for (let i = 0; i < textCount; i += 1) {
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createText({
				id: `t${i}`,
				// Only `distinctKeys` unique strings, so a correct measurement
				// cache sees a high hit rate and an incorrect one does not.
				text: `label-${i % distinctKeys}`,
				bounds: { width: 120, height: 24 },
			}),
		});
	}
	return ir;
}

/** TD §15.1 workload 3: a three-level Hug chain, for edit invalidation. */
function buildHugChain(): CanvasIR {
	const page = createPage({ id: "hug-page" });
	let ir = createCanvasIR({ id: "hug", title: "hug", pages: [page] });
	const bounds = { width: 200, height: 100 };
	const outer = createFrame({ id: "hug-outer", bounds });
	ir = insertNode(ir, { parentId: page.root.id, node: outer });
	const middle = createFrame({ id: "hug-middle", bounds });
	ir = insertNode(ir, { parentId: outer.id, node: middle });
	const inner = createFrame({ id: "hug-inner", bounds });
	ir = insertNode(ir, { parentId: middle.id, node: inner });
	ir = insertNode(ir, {
		parentId: inner.id,
		node: createText({
			id: "hug-text",
			text: "localized",
			bounds: { width: 120, height: 24 },
		}),
	});
	return ir;
}

interface Row {
	readonly workload: string;
	readonly phase: "cold" | "warm";
	readonly targetMs: number;
	readonly summary: Summary;
}

describe("Auto Layout resolver benchmark (T-M0-07)", () => {
	it("reports cold and warm p95 separately for the §15.1 workloads", async () => {
		const resolver = await loadResolver();
		const env = referenceEnvironmentStatus();

		const workloads: {
			name: string;
			ir: CanvasIR;
			/** The localized edit whose re-resolution the warm figure measures. */
			edit: (ir: CanvasIR) => CanvasIR;
		}[] = [
			{
				name: "1k-nodes-30pct-frames",
				ir: buildLargeDocument(),
				edit: (ir) =>
					updateNode(ir, {
						id: "r1",
						patch: { bounds: { width: 111, height: 40 } },
					}),
			},
			{
				name: "100-text-20-keys",
				ir: buildTextDocument(),
				edit: (ir) => updateNode(ir, { id: "t7", patch: { text: "edited" } }),
			},
			{
				// TD §15.1 workload 3 exactly: one localized text edit
				// invalidating a three-level Hug chain.
				name: "hug-chain-depth-3",
				ir: buildHugChain(),
				edit: (ir) =>
					updateNode(ir, {
						id: "hug-text",
						patch: { text: "localized-edit" },
					}),
			},
		];

		const rows: Row[] = [];
		for (const { name, ir, edit } of workloads) {
			rows.push({
				workload: name,
				phase: "cold",
				targetMs: TARGET_COLD_MS,
				summary: measure(() => resolver.resolveCold(ir)),
			});
			// Warm = "one localized edit landed, re-resolve with a valid subtree
			// cache" (TD §15.1), not "resolve the identical document again" —
			// the latter short-circuits at the page root and measures nothing
			// the ≤16 ms target cares about.
			const primed = resolver.resolveCold(ir);
			const editedIr = edit(ir);
			rows.push({
				workload: name,
				phase: "warm",
				targetMs: TARGET_WARM_MS,
				summary: measure(() => resolver.resolveWarm(editedIr, primed)),
			});
		}

		const gatingBlockers: string[] = [];
		if (resolver.isStub)
			gatingBlockers.push("stub resolver (real one lands in M2)");
		if (!env.eligible) gatingBlockers.push(env.reason);
		const gatingEnabled = gatingBlockers.length === 0;

		const cpu = cpus()[0];
		console.log(
			[
				"",
				"Auto Layout resolver benchmark (plan 0022 T-M0-07)",
				`  resolver:    ${resolver.id}${resolver.isStub ? "  [STUB — not the real resolver]" : ""}`,
				`  host:        ${cpu?.model ?? "unknown"} · ${cpus().length} cores · ${(totalmem() / 1024 ** 3).toFixed(1)} GB`,
				`  node:        ${process.version} · ${platform()}-${arch()}`,
				`  sampling:    ${WARMUP} warm-up + ${RUNS} samples per figure`,
				`  environment: ${env.eligible ? "MATCHES the recorded reference" : "NOT the reference"} — ${env.reason}`,
				`  gating:      ${gatingEnabled ? "ENABLED" : `DISABLED — ${gatingBlockers.join("; ")}`}`,
				"",
				"  workload                    phase   median      p95   spread   target",
				"  " + "-".repeat(69),
				...rows.map(
					(r) =>
						`  ${r.workload.padEnd(26)} ${r.phase.padEnd(6)} ${r.summary.median.toFixed(3).padStart(8)} ${r.summary.p95.toFixed(3).padStart(8)} ${(spreadOf(r.summary)?.toFixed(2) ?? "n/a").padStart(7)} ${`${r.targetMs} ms`.padStart(8)}`,
				),
				"",
				gatingEnabled
					? "  Figures above ARE a pass/fail signal on this host."
					: "  Figures above are NOT a pass/fail signal. See bench/REFERENCE-ENVIRONMENT.md.",
				"",
			].join("\n"),
		);

		// What this test actually asserts: the harness produced a real sample
		// for every workload in both phases. The latency values themselves are
		// deliberately unasserted while gating is disabled — an assertion that
		// a stub is fast would be a false green.
		expect(rows).toHaveLength(workloads.length * 2);
		for (const row of rows) {
			expect(row.summary.runs, `${row.workload}/${row.phase}`).toBe(RUNS);
			expect(
				row.summary.p95,
				`${row.workload}/${row.phase} produced no timing`,
			).toBeGreaterThanOrEqual(0);
		}

		if (!gatingEnabled) {
			// T-M5-04: with ANVILKIT_CANVAS_BENCH_REQUIRE_GATING=1 a run that
			// cannot gate is a FAILURE, not a report — the vacuous-green mode
			// (fingerprint mismatch → early return → "passed") is exactly the
			// silent-gap REVIEW-0019 §2 P1 documented for editor-perf. Set the
			// flag wherever this bench is meant to ENFORCE (the reference host;
			// a CI runner once a CI hardware class is nominated in
			// REFERENCE_ENVIRONMENT — see REFERENCE-ENVIRONMENT.md).
			if (process.env.ANVILKIT_CANVAS_BENCH_REQUIRE_GATING === "1") {
				throw new Error(
					`gating required but DISABLED — ${gatingBlockers.join("; ")}`,
				);
			}
			// A run that cannot gate must always say why — otherwise "no failure"
			// reads as "passed".
			expect(
				gatingBlockers.length,
				"a non-gating run must explain why",
			).toBeGreaterThan(0);
			return;
		}

		// Gating path — reachable once M2 lands the real resolver on this host.
		// Stability is asserted BEFORE latency: a run too noisy to trust must
		// fail as noisy rather than accidentally pass or fail on latency.
		for (const row of rows) {
			const spread = spreadOf(row.summary);
			// `null` = below timer-granularity relevance, so there is nothing to
			// judge; a figure that fast is not the one the budget is about.
			if (spread === null) continue;
			expect(
				spread,
				`${row.workload}/${row.phase} p95/median spread — run too noisy to gate on; re-run on an idle machine`,
			).toBeLessThanOrEqual(MAX_STABLE_SPREAD);
		}
		for (const row of rows) {
			expect(
				row.summary.p95,
				`${row.workload}/${row.phase} p95 exceeds the PRD §13.1 budget`,
			).toBeLessThanOrEqual(row.targetMs);
		}
	});

	it("builds the §15.1 workload shapes to spec", () => {
		// The fixtures are the measurement's independent variable; if they
		// silently shrink, every later figure improves for the wrong reason.
		const large = buildLargeDocument();
		const countNodes = (node: CanvasNode): number => {
			const children = (node as { children?: readonly CanvasNode[] }).children;
			return 1 + (children?.reduce((sum, c) => sum + countNodes(c), 0) ?? 0);
		};
		// +1 for the page root itself, which is not one of the 1,000.
		expect(countNodes(large.pages[0]?.root as CanvasNode)).toBe(1_001);

		const text = buildTextDocument();
		const textRoot = text.pages[0]?.root as
			| { children: readonly CanvasNode[] }
			| undefined;
		expect(textRoot?.children).toHaveLength(100);

		const hug = buildHugChain();
		let depth = 0;
		let cursor = hug.pages[0]?.root as CanvasNode | undefined;
		while (cursor) {
			const children = (cursor as { children?: readonly CanvasNode[] })
				.children;
			if (!children || children.length === 0) break;
			cursor = children[0];
			depth += 1;
		}
		// page root → outer → middle → inner → text
		expect(depth).toBe(4);
	});
});
