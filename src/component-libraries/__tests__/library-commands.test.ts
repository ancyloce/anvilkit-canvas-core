import { describe, expect, it } from "vitest";

import { CanvasCommandError } from "../../commands/runtime.js";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import { createCanvasIR } from "../../ir/builders.js";
import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasGroupNode,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import type { CanvasValidatedExternalSnapshot } from "../admission.js";
import {
	type CanvasComponentInsertExternalCommand,
	createExternalInsertCommandHandlers,
	INSERT_EXTERNAL_COMMAND,
} from "../commands/insert-external.js";
import {
	createSnapshotRecoveryCommandHandlers,
	RECOVER_SNAPSHOT_COMMAND,
} from "../commands/recover-snapshot.js";

/**
 * T-021 / T-023 — the two library commands.
 *
 * Driven through a real `createCanvasRuntime()` rather than by calling the
 * handlers directly, because "registers through the extension seam" IS the
 * contract under test (the plan's `commands/runtime.ts` wiring is not
 * implementable — see the module headers).
 */

function ref(
	componentId: string,
	version = "1.0.0",
	integritySeed = componentId,
): CanvasExternalComponentRef {
	return {
		kind: "library",
		libraryId: "acme",
		componentId,
		version,
		integrity: `sha256-${integritySeed.padEnd(43, "x").slice(0, 43)}`,
	};
}

/**
 * A branded snapshot WITHOUT running admission.
 *
 * The brand is unforgeable in application code by design; a test that needs a
 * verified-looking value has to cast, and doing it in one named helper keeps
 * that concession visible instead of scattered through the file.
 */
function verified(
	self: CanvasExternalComponentRef,
	options: {
		dependencies?: readonly CanvasExternalComponentRef[];
		children?: readonly CanvasNode[];
		name?: string;
	} = {},
): CanvasValidatedExternalSnapshot {
	return {
		ref: self,
		definition: {
			id: self.componentId,
			name: options.name ?? self.componentId,
			revision: 1,
			root: {
				id: `${self.componentId}-root`,
				type: "frame",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: { width: 10, height: 10 },
				zIndex: 0,
				children: options.children ?? [],
			},
			properties: [],
		},
		dependencies: options.dependencies ?? [],
		canonicalFormatVersion: 1,
	} as unknown as CanvasValidatedExternalSnapshot;
}

function runtime() {
	return createCanvasRuntime([
		{
			id: "plan-0021-libraries",
			commands: [
				...createExternalInsertCommandHandlers(),
				...createSnapshotRecoveryCommandHandlers(),
			],
		},
	]);
}

/**
 * Apply with a PINNED clock.
 *
 * Every mutation bumps `metadata.updatedAt` by design, so comparing a reverted
 * document against the original tests wall-clock unless the clock is fixed.
 * Pinning it is what lets the inverse assertions be exact equality.
 */
const AT = { now: () => "t0" } as const;
function applyAt(
	rt: ReturnType<typeof runtime>,
	ir: CanvasIR,
	cmd: Parameters<ReturnType<typeof runtime>["apply"]>[1],
) {
	return rt.apply(ir, cmd, AT);
}

function emptyDoc(): CanvasIR {
	return createCanvasIR({ id: "doc", now: () => "t0" });
}

function insertCmd(
	doc: CanvasIR,
	overrides: Partial<CanvasComponentInsertExternalCommand> = {},
): CanvasComponentInsertExternalCommand {
	const candidate = overrides.candidate ?? verified(ref("button"));
	return {
		type: INSERT_EXTERNAL_COMMAND,
		candidate,
		source: candidate.ref,
		instanceId: "inst-1",
		bounds: { width: 100, height: 40 },
		parentId: doc.pages[0]?.root.id as string,
		...overrides,
	} as CanvasComponentInsertExternalCommand;
}

function instancesOf(ir: CanvasIR): CanvasNode[] {
	const root = ir.pages[0]?.root as CanvasGroupNode;
	return root.children.filter((n) => n.type === "component-instance");
}

describe("component-instance.insert-external (T-021)", () => {
	it("is dispatched through the extension registry", () => {
		const rt = runtime();
		expect(rt.commands.has(INSERT_EXTERNAL_COMMAND)).toBe(true);
		expect(rt.commands.has(RECOVER_SNAPSHOT_COMMAND)).toBe(true);
	});

	it("inserts ONE snapshot and ONE instance in one command (AC-001)", () => {
		const doc = emptyDoc();
		const { ir } = applyAt(runtime(), doc, insertCmd(doc));
		expect(Object.keys(ir.externalComponentSnapshots ?? {})).toHaveLength(1);
		expect(instancesOf(ir)).toHaveLength(1);
		expect(instancesOf(ir)[0]?.id).toBe("inst-1");
	});

	it("points the instance at the exact verified reference", () => {
		const doc = emptyDoc();
		const candidate = verified(ref("button"));
		const { ir } = applyAt(runtime(), doc, insertCmd(doc, { candidate }));
		const instance = instancesOf(ir)[0] as { source?: unknown };
		expect(instance.source).toEqual(candidate.ref);
	});

	it("stores the snapshot under its derived key", () => {
		const doc = emptyDoc();
		const candidate = verified(ref("button"));
		const { ir } = applyAt(runtime(), doc, insertCmd(doc, { candidate }));
		expect(
			ir.externalComponentSnapshots?.[snapshotKey(candidate.ref)],
		).toBeDefined();
	});

	it("REUSES an identical snapshot on a repeated insert (M2 exit)", () => {
		const rt = runtime();
		const doc = emptyDoc();
		const candidate = verified(ref("button"));
		const first = applyAt(rt, doc, insertCmd(doc, { candidate })).ir;
		const second = applyAt(rt, 
			first,
			insertCmd(first, { candidate, instanceId: "inst-2" }),
		).ir;

		expect(Object.keys(second.externalComponentSnapshots ?? {})).toHaveLength(
			1,
		);
		expect(instancesOf(second)).toHaveLength(2);
	});

	it("stores two entries for two DIFFERENT versions", () => {
		const rt = runtime();
		const doc = emptyDoc();
		const v1 = verified(ref("button", "1.0.0", "v1"));
		const v2 = verified(ref("button", "2.0.0", "v2"));
		const first = applyAt(rt, doc, insertCmd(doc, { candidate: v1 })).ir;
		const second = applyAt(rt, 
			first,
			insertCmd(first, { candidate: v2, instanceId: "inst-2" }),
		).ir;
		expect(Object.keys(second.externalComponentSnapshots ?? {})).toHaveLength(
			2,
		);
	});

	describe("rejects, and mutates nothing (all-or-nothing)", () => {
		it("refuses when `source` does not equal the verified candidate's ref", () => {
			// The substitution attack: store one component's bytes, point the
			// instance at another's identity. Every field validates individually.
			const doc = emptyDoc();
			const cmd = insertCmd(doc, { source: ref("something-else") });
			expect(() => applyAt(runtime(), doc, cmd)).toThrow(CanvasCommandError);
			try {
				applyAt(runtime(), doc, cmd);
			} catch (error) {
				expect((error as CanvasCommandError).code).toBe(
					"component-integrity-mismatch",
				);
			}
		});

		it("refuses a key collision with differing content", () => {
			const rt = runtime();
			const doc = emptyDoc();
			const original = verified(ref("button"));
			const withSnapshot = applyAt(rt, 
				doc,
				insertCmd(doc, { candidate: original }),
			).ir;

			// Same ref (hence same key) but different bytes — only reachable via a
			// corrupted or hand-edited document, and overwriting would silently
			// restyle every instance already resolving against it.
			const impostor = verified(ref("button"), { name: "Impostor" });
			expect(() =>
				applyAt(rt, 
					withSnapshot,
					insertCmd(withSnapshot, {
						candidate: impostor,
						instanceId: "inst-2",
					}),
				),
			).toThrow(/different content/);
		});

		it("refuses an incomplete dependency closure and inserts nothing", () => {
			const doc = emptyDoc();
			const candidate = verified(ref("outer"), {
				dependencies: [ref("inner")],
				children: [
					{
						id: "nested",
						type: "component-instance",
						transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
						bounds: { width: 5, height: 5 },
						zIndex: 0,
						source: ref("inner"),
					} as CanvasNode,
				],
			});
			expect(() => applyAt(runtime(), doc, insertCmd(doc, { candidate }))).toThrow(
				CanvasCommandError,
			);
		});

		it("accepts the same closure when the dependency travels with it", () => {
			const doc = emptyDoc();
			const inner = verified(ref("inner"));
			const candidate = verified(ref("outer"), {
				dependencies: [ref("inner")],
				children: [
					{
						id: "nested",
						type: "component-instance",
						transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
						bounds: { width: 5, height: 5 },
						zIndex: 0,
						source: ref("inner"),
					} as CanvasNode,
				],
			});
			const { ir } = applyAt(runtime(), 
				doc,
				insertCmd(doc, { candidate, dependencies: [inner] }),
			);
			expect(Object.keys(ir.externalComponentSnapshots ?? {})).toHaveLength(2);
		});

		it("leaves the document byte-identical on a rejected insert", () => {
			const doc = emptyDoc();
			const before = structuredClone(doc);
			try {
				applyAt(runtime(), doc, insertCmd(doc, { source: ref("mismatch") }));
			} catch {
				/* expected */
			}
			expect(doc).toEqual(before);
		});
	});

	describe("inverse (INV)", () => {
		it("restores the document exactly", () => {
			const rt = runtime();
			const doc = emptyDoc();
			const { ir, inverse } = applyAt(rt, doc, insertCmd(doc));
			const reverted = applyAt(rt, ir, inverse).ir;
			expect(reverted).toEqual(doc);
		});

		it("normalizes the emptied registry back to OMISSION, not `{}`", () => {
			const rt = runtime();
			const doc = emptyDoc();
			const { ir, inverse } = applyAt(rt, doc, insertCmd(doc));
			const reverted = applyAt(rt, ir, inverse).ir;
			expect("externalComponentSnapshots" in reverted).toBe(false);
		});

		it("removes only the snapshots THIS insert added", () => {
			// Undoing the second insert must not remove the shared snapshot the
			// first instance still resolves against.
			const rt = runtime();
			const doc = emptyDoc();
			const candidate = verified(ref("button"));
			const first = applyAt(rt, doc, insertCmd(doc, { candidate })).ir;
			const { ir: second, inverse } = applyAt(rt, 
				first,
				insertCmd(first, { candidate, instanceId: "inst-2" }),
			);

			const reverted = applyAt(rt, second, inverse).ir;
			expect(
				Object.keys(reverted.externalComponentSnapshots ?? {}),
			).toHaveLength(1);
			expect(instancesOf(reverted)).toHaveLength(1);
			expect(reverted).toEqual(first);
		});

		it("redoes through the inverse's own inverse", () => {
			const rt = runtime();
			const doc = emptyDoc();
			const { ir, inverse } = applyAt(rt, doc, insertCmd(doc));
			const reverted = applyAt(rt, ir, inverse);
			const redone = applyAt(rt, reverted.ir, reverted.inverse).ir;
			expect(redone).toEqual(ir);
		});
	});
});

describe("component-snapshot.recover (T-023)", () => {
	/** A document whose instance references a snapshot that is not stored. */
	function docMissingSnapshot(): {
		doc: CanvasIR;
		missing: CanvasExternalComponentRef;
	} {
		const rt = runtime();
		const base = emptyDoc();
		const candidate = verified(ref("button"));
		const inserted = applyAt(rt, base, insertCmd(base, { candidate })).ir;
		const { externalComponentSnapshots: _dropped, ...withoutRegistry } =
			inserted;
		return { doc: withoutRegistry as CanvasIR, missing: candidate.ref };
	}

	it("restores the missing snapshot", () => {
		const { doc, missing } = docMissingSnapshot();
		const { ir } = applyAt(runtime(), doc, {
			type: RECOVER_SNAPSHOT_COMMAND,
			candidate: verified(missing),
			expectedRef: missing,
		});
		expect(ir.externalComponentSnapshots?.[snapshotKey(missing)]).toBeDefined();
	});

	it("changes NOTHING about the instance", () => {
		const { doc, missing } = docMissingSnapshot();
		const before = structuredClone(instancesOf(doc));
		const { ir } = applyAt(runtime(), doc, {
			type: RECOVER_SNAPSHOT_COMMAND,
			candidate: verified(missing),
			expectedRef: missing,
		});
		expect(instancesOf(ir)).toEqual(before);
	});

	it("REFUSES to substitute a different version", () => {
		// The failure this command exists to prevent: a "repair" that quietly
		// restyles the document to whatever version happened to be available.
		const { doc, missing } = docMissingSnapshot();
		const otherVersion = ref("button", "2.0.0", "v2");
		expect(() =>
			applyAt(runtime(), doc, {
				type: RECOVER_SNAPSHOT_COMMAND,
				candidate: verified(otherVersion),
				expectedRef: missing,
			}),
		).toThrow(/exact-version only/);
	});

	it("is idempotent — recovering twice is a no-op, not a duplicate", () => {
		const { doc, missing } = docMissingSnapshot();
		const rt = runtime();
		const cmd = {
			type: RECOVER_SNAPSHOT_COMMAND,
			candidate: verified(missing),
			expectedRef: missing,
		} as const;
		const once = applyAt(rt, doc, cmd).ir;
		const twice = applyAt(rt, once, cmd);
		expect(twice.ir).toEqual(once);
		// Nothing was added the second time, so undo removes nothing.
		expect(applyAt(rt, twice.ir, twice.inverse).ir).toEqual(once);
	});

	it("inverse removes ONLY the recovered snapshot (DoD)", () => {
		const rt = runtime();
		const base = emptyDoc();
		const kept = verified(ref("card", "1.0.0", "card"));
		const withKept = applyAt(rt, base, insertCmd(base, { candidate: kept })).ir;

		const recovered = ref("button");
		const { ir, inverse } = applyAt(rt, withKept, {
			type: RECOVER_SNAPSHOT_COMMAND,
			candidate: verified(recovered),
			expectedRef: recovered,
		});
		expect(Object.keys(ir.externalComponentSnapshots ?? {})).toHaveLength(2);

		const reverted = applyAt(rt, ir, inverse).ir;
		expect(Object.keys(reverted.externalComponentSnapshots ?? {})).toEqual([
			snapshotKey(kept.ref),
		]);
		expect(reverted).toEqual(withKept);
	});
});
