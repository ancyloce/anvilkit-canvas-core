import { describe, expect, it } from "vitest";

import { createBrandPolicyEvaluator } from "../../brand-governance/command-policy.js";
import type { CanvasBrandPolicyContext } from "../../brand-governance/types.js";
import type { CanvasCommandError } from "../../commands/runtime.js";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import {
	createCanvasIR,
	createComponentInstance,
	createGroup,
	createRect,
} from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasComponentDefinition,
	CanvasExternalComponentRef,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import { admitExternalSnapshot } from "../admission.js";
import { createExternalInsertCommandHandlers } from "../commands/insert-external.js";
import { createSourceChangeCommandHandlers } from "../commands/update-source.js";

/**
 * @file Policy enforcement on the three LIBRARY commands (plan 0021 M5
 * follow-up #1).
 *
 * ## Why this file exists separately from `command-policy.test.ts`
 *
 * That suite proves the gateway decides all nine operations correctly, and that
 * enforcement reaches the built-in command path (`override-set`,
 * `override-reset`, `detach`) — everything reachable from `commands/runtime.ts`.
 *
 * `insert-external`, `source-update` and `source-swap` are not reachable from
 * there: they carry rank-4 branded types and register through the extension
 * seam. Until this file, they were decided correctly and never asked — a
 * gateway nothing calls is not enforcement, and the M5 ledger recorded them as
 * an open bypass. These tests drive the REAL handlers through
 * `createCanvasRuntime` with `brandPolicy` wired, and assert both halves:
 * the mutation is refused, AND the document is byte-identical afterwards.
 */

const ALWAYS_VALID = { verify: async () => true };

const REF: CanvasExternalComponentRef = {
	kind: "library",
	libraryId: "acme",
	componentId: "card",
	version: "1.0.0",
	integrity: `sha256-${"A".repeat(43)}`,
};
const V2: CanvasExternalComponentRef = {
	...REF,
	version: "2.0.0",
	integrity: `sha256-${"B".repeat(43)}`,
};
const OTHER: CanvasExternalComponentRef = {
	...REF,
	componentId: "banner",
	integrity: `sha256-${"C".repeat(43)}`,
};

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

function capabilities(over: Record<string, boolean> = {}) {
	return {
		canEditOverrides: true,
		canChangeVariant: true,
		canDetach: true,
		canFlatten: true,
		canInsertExternalComponents: true,
		canUpdateComponents: true,
		...over,
	};
}

function context(
	overrides: Partial<CanvasBrandPolicyContext> = {},
): CanvasBrandPolicyContext {
	return {
		enforcement: "blocking",
		capabilities: capabilities(),
		...overrides,
	} as CanvasBrandPolicyContext;
}

/** A runtime with the library command handlers registered. */
function runtime() {
	return createCanvasRuntime([
		{
			id: "component-libraries",
			commands: [
				...createExternalInsertCommandHandlers(),
				...createSourceChangeCommandHandlers(),
			],
		},
	]);
}

function withPolicy(ir: CanvasIR, ctx: CanvasBrandPolicyContext) {
	return {
		now: () => "t0",
		brandPolicy: { evaluate: createBrandPolicyEvaluator(ir), context: ctx },
	};
}

async function candidateFor(
	ref: CanvasExternalComponentRef,
	definition: CanvasComponentDefinition = DEFINITION,
) {
	const result = await admitExternalSnapshot(
		{
			canonicalFormatVersion: 1,
			ref,
			definition,
			dependencies: [],
		},
		{ verifier: ALWAYS_VALID },
	);
	if (!result.ok)
		throw new Error(`admission failed: ${result.diagnostic.code}`);
	return result.snapshot;
}

/** A document with one external instance of `REF`, plus its snapshot. */
async function docWithInstance(policy?: Record<string, unknown>) {
	const candidate = await candidateFor(REF);
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	const instance = {
		...createComponentInstance({
			id: "inst-1",
			componentId: "card",
			bounds: { width: 10, height: 10 },
		}),
		source: REF,
	} as unknown as CanvasNode;
	const withInstance = insertNode(base, {
		parentId: base.pages[0]?.root.id as string,
		node: instance,
		now: () => "t0",
	});
	return {
		...withInstance,
		externalComponentSnapshots: {
			[snapshotKey(REF)]: {
				...candidate,
				...(policy ? { definition: { ...DEFINITION, policy } } : {}),
			},
		},
	} as CanvasIR;
}

describe("insert-external is guarded at the COMMAND layer", () => {
	it("refuses the insert when the capability is denied", async () => {
		const candidate = await candidateFor(REF);
		const ir = createCanvasIR({ id: "doc", now: () => "t0" });
		const before = structuredClone(ir);
		const denied = context({
			capabilities: capabilities({ canInsertExternalComponents: false }),
		});

		expect(() =>
			runtime().apply(
				ir,
				{
					type: "component-instance.insert-external",
					nodeId: "new-inst",
					pageId: ir.pages[0]?.id as string,
					parentId: ir.pages[0]?.root.id as string,
					source: REF,
					candidate,
					bounds: { width: 10, height: 10 },
				} as never,
				withPolicy(ir, denied),
			),
		).toThrow(/capability-denied/);

		// Atomic: no instance, no snapshot, nothing.
		expect(ir).toEqual(before);
		expect(ir.externalComponentSnapshots).toBeUndefined();
	});

	it("allows the insert when the capability is granted", async () => {
		const candidate = await candidateFor(REF);
		const ir = createCanvasIR({ id: "doc", now: () => "t0" });
		const next = runtime().apply(
			ir,
			{
				type: "component-instance.insert-external",
				nodeId: "new-inst",
				pageId: ir.pages[0]?.id as string,
				parentId: ir.pages[0]?.root.id as string,
				source: REF,
				candidate,
				bounds: { width: 10, height: 10 },
			} as never,
			withPolicy(ir, context()),
		);
		expect(Object.keys(next.ir.externalComponentSnapshots ?? {})).toHaveLength(
			1,
		);
	});

	it("is a no-op when no brandPolicy is wired at all", async () => {
		// Every pre-M4 caller. Enforcement must be additive.
		const candidate = await candidateFor(REF);
		const ir = createCanvasIR({ id: "doc", now: () => "t0" });
		expect(() =>
			runtime().apply(
				ir,
				{
					type: "component-instance.insert-external",
					nodeId: "new-inst",
					pageId: ir.pages[0]?.id as string,
					parentId: ir.pages[0]?.root.id as string,
					source: REF,
					candidate,
					bounds: { width: 10, height: 10 },
				} as never,
				{ now: () => "t0" },
			),
		).not.toThrow();
	});
});

describe("source-update and source-swap are guarded at the COMMAND layer", () => {
	it("refuses an update when the capability is denied", async () => {
		const ir = await docWithInstance();
		const before = structuredClone(ir);
		const candidate = await candidateFor(V2);
		const denied = context({
			capabilities: capabilities({ canUpdateComponents: false }),
		});

		expect(() =>
			runtime().apply(
				ir,
				{
					type: "component-instance.update-source",
					instanceIds: ["inst-1"],
					from: REF,
					candidate,
				} as never,
				withPolicy(ir, denied),
			),
		).toThrow(/capability-denied/);
		expect(ir).toEqual(before);
	});

	it("refuses a SWAP under the same capability", async () => {
		const ir = await docWithInstance();
		const before = structuredClone(ir);
		const candidate = await candidateFor(OTHER, {
			...DEFINITION,
			id: "banner",
		} as CanvasComponentDefinition);
		const denied = context({
			capabilities: capabilities({ canUpdateComponents: false }),
		});

		expect(() =>
			runtime().apply(
				ir,
				{
					type: "component-instance.swap-source",
					instanceIds: ["inst-1"],
					from: REF,
					candidate,
				} as never,
				withPolicy(ir, denied),
			),
		).toThrow(/capability-denied/);
		expect(ir).toEqual(before);
	});

	it("allows an update when the capability is granted", async () => {
		const ir = await docWithInstance();
		const candidate = await candidateFor(V2);
		const next = runtime().apply(
			ir,
			{
				type: "component-instance.update-source",
				instanceIds: ["inst-1"],
				from: REF,
				candidate,
			} as never,
			withPolicy(ir, context()),
		);
		const instance = next.ir.pages[0]?.root.children?.[0] as {
			source: CanvasExternalComponentRef;
		};
		expect(instance.source.version).toBe("2.0.0");
	});

	it("attaches the structured decision, like every other denial", async () => {
		const ir = await docWithInstance();
		const candidate = await candidateFor(V2);
		let caught: unknown;
		try {
			runtime().apply(
				ir,
				{
					type: "component-instance.update-source",
					instanceIds: ["inst-1"],
					from: REF,
					candidate,
				} as never,
				withPolicy(
					ir,
					context({
						capabilities: capabilities({ canUpdateComponents: false }),
					}),
				),
			);
		} catch (error) {
			caught = error;
		}
		const error = caught as CanvasCommandError;
		// The Editor localizes `reason`; it must never have to parse `message`.
		expect(error.code).toBe("brand-policy-denied");
		expect(error.policy?.reason).toBe("capability-denied");
	});
});

describe("the POLICY path rule reaches the real command (TD §15.1)", () => {
	/**
	 * The capability tests above prove the host's switch works. These prove the
	 * component's own policy does — the half that was missing until the path
	 * rules were added, and the half a brand owner actually authors.
	 */

	it("`allowSourceUpdate: false` on the snapshot refuses the update", async () => {
		const ir = await docWithInstance({ allowSourceUpdate: false });
		const before = structuredClone(ir);
		const candidate = await candidateFor(V2);

		expect(() =>
			runtime().apply(
				ir,
				{
					type: "component-instance.update-source",
					instanceIds: ["inst-1"],
					from: REF,
					candidate,
				} as never,
				withPolicy(ir, context()),
			),
		).toThrow(/source-update-denied/);
		expect(ir).toEqual(before);
	});

	it("...while a SWAP of the same instance is still allowed", async () => {
		// The asymmetry, end to end through the real handler: pinning the version
		// must not incidentally forbid replacing the component.
		const ir = await docWithInstance({ allowSourceUpdate: false });
		const candidate = await candidateFor(OTHER, {
			...DEFINITION,
			id: "banner",
		} as CanvasComponentDefinition);
		expect(() =>
			runtime().apply(
				ir,
				{
					type: "component-instance.swap-source",
					instanceIds: ["inst-1"],
					from: REF,
					candidate,
				} as never,
				withPolicy(ir, context()),
			),
		).not.toThrow();
	});

	it("`allowSourceSwap: false` refuses the swap and keeps the document intact", async () => {
		const ir = await docWithInstance({ allowSourceSwap: false });
		const before = structuredClone(ir);
		const candidate = await candidateFor(OTHER, {
			...DEFINITION,
			id: "banner",
		} as CanvasComponentDefinition);

		expect(() =>
			runtime().apply(
				ir,
				{
					type: "component-instance.swap-source",
					instanceIds: ["inst-1"],
					from: REF,
					candidate,
				} as never,
				withPolicy(ir, context()),
			),
		).toThrow(/source-swap-denied/);
		expect(ir).toEqual(before);
	});

	it("attaches the policy reason as the structured decision", async () => {
		const ir = await docWithInstance({ allowSourceUpdate: false });
		const candidate = await candidateFor(V2);
		let caught: unknown;
		try {
			runtime().apply(
				ir,
				{
					type: "component-instance.update-source",
					instanceIds: ["inst-1"],
					from: REF,
					candidate,
				} as never,
				withPolicy(ir, context()),
			);
		} catch (error) {
			caught = error;
		}
		// The Editor localizes this code; `source-update-denied` and
		// `capability-denied` get different copy because they have different
		// remedies.
		expect((caught as CanvasCommandError).policy?.reason).toBe(
			"source-update-denied",
		);
	});

	it("commits under advisory enforcement instead of blocking", async () => {
		// OD-10 end to end: the component recommends nothing, the host is only
		// warning, so the edit lands and is reported rather than refused.
		const ir = await docWithInstance({ allowSourceUpdate: false });
		const candidate = await candidateFor(V2);
		const next = runtime().apply(
			ir,
			{
				type: "component-instance.update-source",
				instanceIds: ["inst-1"],
				from: REF,
				candidate,
			} as never,
			withPolicy(ir, context({ enforcement: "warning" })),
		);
		const instance = next.ir.pages[0]?.root.children?.[0] as {
			source: CanvasExternalComponentRef;
		};
		expect(instance.source.version).toBe("2.0.0");
	});
});

describe("every named instance is asked, and a refusal aborts the whole batch", () => {
	/** Two instances of the same external component. */
	async function twoInstanceDoc(): Promise<CanvasIR> {
		const candidate = await candidateFor(REF);
		const base = createCanvasIR({ id: "doc", now: () => "t0" });
		let ir = base;
		for (const id of ["inst-1", "inst-2"]) {
			ir = insertNode(ir, {
				parentId: base.pages[0]?.root.id as string,
				node: {
					...createComponentInstance({
						id,
						componentId: "card",
						bounds: { width: 10, height: 10 },
					}),
					source: REF,
				} as unknown as CanvasNode,
				now: () => "t0",
			});
		}
		return {
			...ir,
			externalComponentSnapshots: { [snapshotKey(REF)]: candidate },
		} as CanvasIR;
	}

	it("asks policy once PER INSTANCE, not once per command", async () => {
		// Worth asserting even though today's rule set is capability-only for
		// source operations, i.e. every instance currently yields the same
		// answer. The gateway's contract is an intersection down each instance's
		// OWN path (OD-08), so the day a path rule is added for `source-update`,
		// a per-command check would silently apply the first instance's answer to
		// all of them. This pins the shape now, while it is cheap.
		const ir = await twoInstanceDoc();
		const candidate = await candidateFor(V2);
		const asked: Array<{ operation: string; instanceId?: string }> = [];

		runtime().apply(
			ir,
			{
				type: "component-instance.update-source",
				instanceIds: ["inst-1", "inst-2"],
				from: REF,
				candidate,
			} as never,
			{
				now: () => "t0",
				brandPolicy: {
					evaluate: (query) => {
						asked.push({
							operation: query.operation,
							...(query.instanceId !== undefined
								? { instanceId: query.instanceId }
								: {}),
						});
						return { outcome: "allow" };
					},
					context: context(),
				},
			},
		);

		expect(asked).toEqual([
			{ operation: "source-update", instanceId: "inst-1" },
			{ operation: "source-update", instanceId: "inst-2" },
		]);
	});

	it("a denial on the SECOND instance leaves the document untouched", async () => {
		// The failure this prevents: an update across 200 instances that refuses
		// on number 150 and leaves the document half-migrated. A host-supplied
		// evaluator is the honest way to exercise it — the port is precisely the
		// seam a host implements, and no built-in rule differentiates instances
		// for this operation yet.
		const ir = await twoInstanceDoc();
		const before = structuredClone(ir);
		const candidate = await candidateFor(V2);

		expect(() =>
			runtime().apply(
				ir,
				{
					type: "component-instance.update-source",
					instanceIds: ["inst-1", "inst-2"],
					from: REF,
					candidate,
				} as never,
				{
					now: () => "t0",
					brandPolicy: {
						evaluate: (query) =>
							query.instanceId === "inst-2"
								? { outcome: "deny", reason: "structure-locked" }
								: { outcome: "allow" },
						context: context(),
					},
				},
			),
		).toThrow(/structure-locked/);

		// `inst-1` was permitted and still must not have moved.
		expect(ir).toEqual(before);
	});

	it("a `warn` decision does NOT block the batch (advisory mode)", async () => {
		// Collapsing warn into deny would make advisory mode unusable; collapsing
		// it into allow would lose the report. It must commit AND be reportable.
		const ir = await twoInstanceDoc();
		const candidate = await candidateFor(V2);
		const next = runtime().apply(
			ir,
			{
				type: "component-instance.update-source",
				instanceIds: ["inst-1", "inst-2"],
				from: REF,
				candidate,
			} as never,
			{
				now: () => "t0",
				brandPolicy: {
					evaluate: () => ({ outcome: "warn", reason: "structure-locked" }),
					context: context({ enforcement: "warning" }),
				},
			},
		);
		const instance = next.ir.pages[0]?.root.children?.[0] as {
			source: CanvasExternalComponentRef;
		};
		expect(instance.source.version).toBe("2.0.0");
	});
});
