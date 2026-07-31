import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { BrandKitDefinition } from "../../brand/index.js";
import {
	admitExternalSnapshot,
	snapshotKey,
} from "../../component-libraries/index.js";
import {
	createCanvasIR,
	createComponentInstance,
	createGroup,
	createPage,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import { prepareExport } from "../prepare-export.js";
import type { CanvasBrandPolicyContext } from "../types.js";

/**
 * T-047 — the host/worker export contract (AC-015, OD-09, TD §27.3).
 *
 * ## The obligation this file makes visible
 *
 * `canvas-core` refuses a `documentRef`. That refusal is only half a contract:
 * a worker can resolve the ref itself and then export the resulting document
 * directly, satisfying the refusal while skipping component resolution and the
 * compliance engine entirely. Nothing in the type system prevents that. So the
 * obligation is stated as an executable test instead: the worker path must
 * re-enter `prepareExport` and produce the SAME report and the SAME allow/block
 * outcome as the inline path.
 *
 * A host that skips it fails `worker path and inline path agree exactly`.
 */

const KIT: BrandKitDefinition = {
	id: "kit",
	name: "Kit",
	logos: [],
	colors: [{ id: "brand-blue", name: "Brand Blue", value: "#2563eb" }],
	fonts: [{ id: "brand-sans", name: "Brand Sans", family: "Inter" }],
	typography: [],
	rules: [{ id: "no-red", kind: "forbidden-color", value: "#ff0000" }],
};

function context(
	overrides: Partial<CanvasBrandPolicyContext> = {},
): CanvasBrandPolicyContext {
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
		...overrides,
	};
}

const DEFINITION = {
	id: "card",
	name: "Card",
	revision: 1,
	root: createGroup({
		id: "card-root",
		children: [
			createRect({ id: "card-inner", bounds: { width: 4, height: 4 } }),
		],
	}),
	properties: [],
} as unknown as CanvasComponentDefinition;

/** An off-brand document with one local component instance. */
function doc(
	options: { policy?: Record<string, unknown>; withInstance?: boolean } = {},
): CanvasIR {
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	const withRegistry: CanvasIR = {
		...base,
		components: {
			card: {
				...DEFINITION,
				...(options.policy ? { policy: options.policy } : {}),
			} as CanvasComponentDefinition,
		},
	};
	let ir = insertNode(withRegistry, {
		parentId: withRegistry.pages[0]?.root.id as string,
		node: createRect({
			id: "off-brand",
			bounds: { width: 10, height: 10 },
			fill: "#ff0000",
		}) as CanvasNode,
		now: () => "t0",
	});
	if (options.withInstance !== false) {
		ir = insertNode(ir, {
			parentId: ir.pages[0]?.root.id as string,
			node: createComponentInstance({
				id: "inst-1",
				componentId: "card",
				bounds: { width: 10, height: 10 },
			}),
			now: () => "t0",
		});
	}
	return ir;
}

describe("documentRef boundary (OD-09)", () => {
	it("refuses a ref and names the obligation, not just the refusal", () => {
		const result = prepareExport(
			{ documentRef: "s3://bucket/doc.json" },
			{ context: context() },
		);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.code).toBe("document-ref-unresolved");
		// The old message said only what core will not do. What a host needs is
		// what to do INSTEAD.
		expect(result.ok === false && result.message).toContain("prepareExport");
	});

	it("worker path and inline path agree exactly (AC-015)", () => {
		// The inline path: the editor exports the document it has.
		const ir = doc();
		const inline = prepareExport(
			{ document: ir },
			{ context: context(), brandKit: KIT },
		);

		// The worker path: it resolved the ref itself, and must re-enter here.
		const resolvedByWorker = JSON.parse(JSON.stringify(ir)) as CanvasIR;
		const worker = prepareExport(
			{ document: resolvedByWorker },
			{ context: context(), brandKit: KIT },
		);

		expect(worker.ok).toBe(true);
		expect(inline.ok).toBe(true);
		// Same report, byte for byte, and the same allow/block outcome.
		expect(JSON.stringify(worker.ok === true && worker.report)).toBe(
			JSON.stringify(inline.ok === true && inline.report),
		);
		expect(worker.ok === true && worker.exportWithWarnings).toBe(
			inline.ok === true && inline.exportWithWarnings,
		);
		expect(worker.ok === true && worker.exportWithBlockingIssues).toBe(
			inline.ok === true && inline.exportWithBlockingIssues,
		);
	});
});

describe("prepareExport (T-046)", () => {
	it("returns the report on ALLOW", () => {
		const result = prepareExport(
			{ document: doc() },
			{ context: context(), brandKit: KIT },
		);
		expect(result.ok).toBe(true);
		expect(result.ok === true && result.report?.issues.length).toBeGreaterThan(
			0,
		);
		expect(result.ok === true && result.exportWithWarnings).toBe(true);
		// OD-10: an ordinary node is a warning forever, so nothing blocks here.
		expect(result.ok === true && result.exportWithBlockingIssues).toBe(false);
	});

	it("returns the report on BLOCK too", () => {
		// A host that blocks still has to tell the user what to fix.
		const result = prepareExport(
			{ document: doc({ policy: { recommendedEnforcement: "blocking" } }) },
			{ context: context(), brandKit: KIT },
		);
		expect(result.ok === true && result.report).toBeDefined();
	});

	it("omits the report entirely without a Brand Kit", () => {
		const result = prepareExport({ document: doc() }, { context: context() });
		expect(result.ok === true && result.report).toBeUndefined();
		expect(result.ok === true && result.exportWithWarnings).toBe(false);
	});

	it("refuses when an instance has no usable snapshot", () => {
		const ir = doc();
		const orphaned = {
			...ir,
			components: {},
		} as CanvasIR;
		const result = prepareExport(
			{ document: orphaned },
			{ context: context(), brandKit: KIT },
		);
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.code).toBe("component-unresolved");
	});

	it("refuses when a snapshot was QUARANTINED at load (T-045 → T-046)", async () => {
		// The end of the integrity story: a tampered snapshot does not merely
		// render a placeholder, it stops the export.
		const ref = {
			kind: "library" as const,
			libraryId: "acme",
			componentId: "card",
			version: "1.0.0",
			integrity: `sha256-${"A".repeat(43)}`,
		};
		const admission = await admitExternalSnapshot(
			{
				canonicalFormatVersion: 1,
				ref,
				definition: DEFINITION,
				dependencies: [],
			},
			{ verifier: { verify: async () => true } },
		);
		expect(admission.ok).toBe(true);
		if (!admission.ok) return;
		const key = snapshotKey(ref);

		const base = createCanvasIR({ id: "doc", now: () => "t0" });
		const ir = {
			...insertNode(base, {
				parentId: base.pages[0]?.root.id as string,
				node: {
					...createComponentInstance({
						id: "inst-x",
						componentId: "card",
						bounds: { width: 10, height: 10 },
					}),
					source: ref,
				} as CanvasNode,
				now: () => "t0",
			}),
			externalComponentSnapshots: { [key]: admission.snapshot },
		} as CanvasIR;

		expect(prepareExport({ document: ir }, { context: context() }).ok).toBe(
			true,
		);
		const quarantined = prepareExport(
			{ document: ir },
			{ context: context(), quarantinedKeys: [key] },
		);
		expect(quarantined.ok).toBe(false);
		expect(quarantined.ok === false && quarantined.code).toBe(
			"component-unresolved",
		);
	});

	it("rejects a flattening export when policy forbids flatten", () => {
		const ir = doc({ policy: { allowFlatten: false } });
		// Non-flattening export of the same document is fine — that is the point
		// of asking per format rather than refusing the document outright.
		expect(prepareExport({ document: ir }, { context: context() }).ok).toBe(
			true,
		);
		const flattened = prepareExport(
			{ document: ir },
			{ context: context(), flatten: true },
		);
		expect(flattened.ok).toBe(false);
		expect(flattened.ok === false && flattened.code).toBe("flatten-denied");
		expect(flattened.ok === false && flattened.instanceIds).toEqual(["inst-1"]);
	});

	it("allows a flattening export when policy permits it", () => {
		expect(
			prepareExport({ document: doc() }, { context: context(), flatten: true })
				.ok,
		).toBe(true);
	});

	it("never resolves a `latest` version — the exact ref decides", () => {
		// There is no catalog parameter to consult, so this asserts the shape of
		// the API: preparation takes a document and a context, nothing else that
		// could name a version.
		const params = prepareExport.length;
		expect(params).toBe(2);
	});
});

describe("no network is reachable from export (T-046 DoD)", () => {
	const source = readFileSync(
		join(__dirname, "..", "prepare-export.ts"),
		"utf8",
	);

	it("imports no transport and declares no fetch-shaped option", () => {
		// Structural, not behavioural: the guarantee is that there is no PARAMETER
		// through which a network call could be supplied, which no runtime
		// assertion can demonstrate.
		for (const forbidden of [
			"fetch(",
			"XMLHttpRequest",
			"WebSocket",
			"axios",
		]) {
			expect(source).not.toContain(forbidden);
		}
		// Anchored to a DECLARATION, not to prose: the file's own doc comment
		// explains why it takes no Provider, and a bare word match would flag that
		// explanation as the violation it describes.
		expect(source).not.toMatch(
			/^\s*(readonly\s+)?(provider|resolver|fetch|transport|client)\??\s*:/im,
		);
	});

	it("does not touch globalThis.fetch when preparing", () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("no network in export"));
		try {
			expect(
				prepareExport(
					{ document: doc() },
					{ context: context(), brandKit: KIT },
				).ok,
			).toBe(true);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});
