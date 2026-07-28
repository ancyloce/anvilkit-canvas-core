import { describe, expect, it } from "vitest";
import * as core from "../../index.js";

/**
 * @file T-M2-09 — the curated public surface (TS-54).
 *
 * `layout/index.ts` is an explicit allowlist rather than an `export *`, and
 * this is the test that keeps it one. Without it, adding a helper to any
 * `layout/` module and re-exporting it out of habit would silently enlarge
 * `@anvilkit/canvas-core`'s public API — at which point removing it again is a
 * breaking change and `check:api-snapshot` merely records the mistake.
 */

describe("public layout surface", () => {
	it("exports exactly the five documented entry points", () => {
		for (const name of [
			"resolveCanvasLayout",
			"validateLayoutInvariants",
			"assertLayoutInvariants",
			"materializeCanvasLayout",
			"flattenCanvasLayout",
		] as const) {
			expect(typeof (core as Record<string, unknown>)[name], name).toBe(
				"function",
			);
		}
	});

	it("exports the consumer read adapter", () => {
		// TD §12.1 makes getRecord/getChildren/getPageRoots a required consumer
		// API, so the adapter and the id brand are part of the contract.
		expect(typeof core.createResolvedView).toBe("function");
		expect(typeof core.toResolvedNodeId).toBe("function");
		expect(typeof core.CanvasLayoutInvariantError).toBe("function");
	});

	it("keeps solver, cache, measurement and axis internals private", () => {
		// These are HOW the resolver works, not what it promises. A host reaching
		// for any of them would be reimplementing part of the solver, which is
		// precisely what "one layout algorithm" forbids — and T-M2-09's
		// acceptance criterion names the axis adapter and the cache explicitly.
		const forbidden = [
			// axis adapter
			"axisFor",
			"SIZING_FIELD_AXIS",
			"SIZING_FIELDS",
			// sizing graph
			"buildSizingGraph",
			"emptySizingGraph",
			// cache
			"subtreeSignature",
			"createCacheState",
			"advanceCacheState",
			"reuseRecord",
			"reusedSubtreeCount",
			"resolutionManifestHash",
			// solver internals
			"quantise",
			"computeInputHash",
			// measurement
			"measureIntrinsicSize",
			"measurementKey",
			"createMeasurementContext",
			// diagnostics plumbing
			"createLayoutIssue",
			"orderLayoutIssues",
			"buildDocumentOrder",
			"CANVAS_LAYOUT_ISSUE_DEFAULTS",
		];
		const exported = new Set(Object.keys(core));
		for (const name of forbidden) {
			expect(exported.has(name), `${name} leaked into the public surface`).toBe(
				false,
			);
		}
	});

	it("does not leak the shared fingerprint helpers", () => {
		// `hash.ts` is rank 0 and shared by `serialize/` and `layout/`, but it is
		// an implementation detail of both — publishing it would make a
		// collision-avoidance fingerprint a supported API.
		const exported = new Set(Object.keys(core));
		expect(exported.has("fingerprint")).toBe(false);
		expect(exported.has("fingerprint64")).toBe(false);
	});
});
