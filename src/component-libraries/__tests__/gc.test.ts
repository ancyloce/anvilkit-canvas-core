import { describe, expect, it } from "vitest";

import { CanvasCommandError } from "../../commands/runtime.js";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import { createCanvasIR, createComponentInstance } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasComponentDefinition,
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
	CanvasIR,
	CanvasNode,
} from "../../ir/types.js";
import {
	COLLECT_UNUSED_COMMAND,
	createCollectUnusedCommandHandlers,
	previewCollectUnused,
} from "../commands/collect-unused.js";
import {
	collectReferencedSnapshotKeys,
	collectUnreferencedSnapshotKeys,
} from "../reference-index.js";

/**
 * T-033 / T-034 — reference closure and undo-safe collection.
 *
 * The acceptance criterion is negative — "no snapshot required by Undo is ever
 * collected" — so most of these assert that something SURVIVES.
 */

const AT = { now: () => "t0" } as const;

function runtime() {
	return createCanvasRuntime([
		{ id: "plan-0021-gc", commands: [...createCollectUnusedCommandHandlers()] },
	]);
}

function ref(componentId: string): CanvasExternalComponentRef {
	return {
		kind: "library",
		libraryId: "acme",
		componentId,
		version: "1.0.0",
		integrity: `sha256-${componentId.padEnd(43, "x").slice(0, 43)}`,
	};
}

function instanceNode(
	id: string,
	source: CanvasExternalComponentRef,
): CanvasNode {
	return {
		id,
		type: "component-instance",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 10, height: 10 },
		zIndex: 0,
		source,
	} as CanvasNode;
}

function snapshotOf(
	self: CanvasExternalComponentRef,
	options: {
		dependencies?: readonly CanvasExternalComponentRef[];
		children?: readonly CanvasNode[];
	} = {},
): CanvasExternalComponentSnapshot {
	return {
		ref: self,
		definition: {
			id: self.componentId,
			name: self.componentId,
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
		} as CanvasComponentDefinition,
		dependencies: options.dependencies ?? [],
		canonicalFormatVersion: 1,
	} as CanvasExternalComponentSnapshot;
}

function docWith(
	snapshots: CanvasExternalComponentSnapshot[],
	options: {
		pageInstances?: CanvasExternalComponentRef[];
		localSourceRef?: CanvasExternalComponentRef;
	} = {},
): CanvasIR {
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	let ir: CanvasIR = {
		...base,
		externalComponentSnapshots: Object.fromEntries(
			snapshots.map((s) => [snapshotKey(s.ref), s]),
		),
	};
	if (options.localSourceRef) {
		ir = {
			...ir,
			components: {
				"cmp-local": {
					id: "cmp-local",
					name: "Local",
					revision: 1,
					root: {
						id: "local-root",
						type: "frame",
						transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
						bounds: { width: 10, height: 10 },
						zIndex: 0,
						children: [instanceNode("nested", options.localSourceRef)],
					},
					properties: [],
				} as CanvasComponentDefinition,
			},
		};
	}
	for (const [i, source] of (options.pageInstances ?? []).entries()) {
		ir = insertNode(ir, {
			parentId: ir.pages[0]?.root.id as string,
			node: createComponentInstance({
				id: `inst-${i + 1}`,
				source,
				bounds: { width: 10, height: 10 },
			}),
			now: () => "t0",
		});
	}
	return ir;
}

describe("collectReferencedSnapshotKeys (T-033)", () => {
	it("finds a reference from a page instance", () => {
		const ir = docWith([snapshotOf(ref("a"))], { pageInstances: [ref("a")] });
		expect([...collectReferencedSnapshotKeys(ir)]).toEqual([
			snapshotKey(ref("a")),
		]);
	});

	it("finds a reference nested inside a LOCAL Source tree", () => {
		// Local components can embed external ones; missing this is how a GC
		// deletes something still rendered.
		const ir = docWith([snapshotOf(ref("a"))], { localSourceRef: ref("a") });
		expect(collectReferencedSnapshotKeys(ir).has(snapshotKey(ref("a")))).toBe(
			true,
		);
	});

	it("follows a TRANSITIVE dependency of a reachable snapshot", () => {
		const inner = snapshotOf(ref("inner"));
		const outer = snapshotOf(ref("outer"), { dependencies: [ref("inner")] });
		const ir = docWith([outer, inner], { pageInstances: [ref("outer")] });
		const reached = collectReferencedSnapshotKeys(ir);
		expect(reached.has(snapshotKey(ref("outer")))).toBe(true);
		expect(reached.has(snapshotKey(ref("inner")))).toBe(true);
	});

	it("follows an instance nested inside a SNAPSHOT's own tree", () => {
		const inner = snapshotOf(ref("inner"));
		const outer = snapshotOf(ref("outer"), {
			children: [instanceNode("n", ref("inner"))],
		});
		const ir = docWith([outer, inner], { pageInstances: [ref("outer")] });
		expect(
			collectReferencedSnapshotKeys(ir).has(snapshotKey(ref("inner"))),
		).toBe(true);
	});

	it("counts a diamond exactly once and terminates on a cycle", () => {
		const a = snapshotOf(ref("a"), { dependencies: [ref("b"), ref("c")] });
		const b = snapshotOf(ref("b"), { dependencies: [ref("d")] });
		const c = snapshotOf(ref("c"), { dependencies: [ref("d")] });
		// `d` points back at `a` — a cycle an unbounded walk would hang on.
		const d = snapshotOf(ref("d"), { dependencies: [ref("a")] });
		const ir = docWith([a, b, c, d], { pageInstances: [ref("a")] });
		expect(collectReferencedSnapshotKeys(ir).size).toBe(4);
	});

	it("reports genuinely unreferenced keys", () => {
		const ir = docWith([snapshotOf(ref("used")), snapshotOf(ref("stale"))], {
			pageInstances: [ref("used")],
		});
		expect(collectUnreferencedSnapshotKeys(ir)).toEqual([
			snapshotKey(ref("stale")),
		]);
	});
});

describe("component-snapshot.collect-unused (T-034)", () => {
	const staleDoc = () =>
		docWith([snapshotOf(ref("used")), snapshotOf(ref("stale"))], {
			pageInstances: [ref("used")],
		});

	it("removes an unreferenced snapshot", () => {
		const { ir } = runtime().apply(
			staleDoc(),
			{ type: COLLECT_UNUSED_COMMAND, retainedSnapshotKeys: new Set<string>() },
			AT,
		);
		expect(Object.keys(ir.externalComponentSnapshots ?? {})).toEqual([
			snapshotKey(ref("used")),
		]);
	});

	it("KEEPS a snapshot referenced only by a retained history entry", () => {
		// The acceptance criterion. Without the retained set this snapshot is
		// unreferenced by the document and would be deleted, and an undo would
		// land on a missing component.
		const { ir } = runtime().apply(
			staleDoc(),
			{
				type: COLLECT_UNUSED_COMMAND,
				retainedSnapshotKeys: new Set([snapshotKey(ref("stale"))]),
			},
			AT,
		);
		expect(Object.keys(ir.externalComponentSnapshots ?? {}).sort()).toEqual(
			[snapshotKey(ref("stale")), snapshotKey(ref("used"))].sort(),
		);
	});

	it("REFUSES when the retained set is missing entirely", () => {
		// Making it required is what stops "safe" being the thing you get by
		// not thinking about it.
		expect(() =>
			runtime().apply(
				staleDoc(),
				{ type: COLLECT_UNUSED_COMMAND } as never,
				AT,
			),
		).toThrow(CanvasCommandError);
	});

	it("is a no-op when nothing is eligible", () => {
		const before = docWith([snapshotOf(ref("used"))], {
			pageInstances: [ref("used")],
		});
		const { ir } = runtime().apply(
			before,
			{ type: COLLECT_UNUSED_COMMAND, retainedSnapshotKeys: new Set<string>() },
			AT,
		);
		expect(ir).toEqual(before);
	});

	it("undo restores the collected snapshots byte-for-byte", () => {
		const rt = runtime();
		const before = staleDoc();
		const { ir, inverse } = rt.apply(
			before,
			{ type: COLLECT_UNUSED_COMMAND, retainedSnapshotKeys: new Set<string>() },
			AT,
		);
		expect(rt.apply(ir, inverse, AT).ir).toEqual(before);
	});

	it("normalizes an emptied registry to omission", () => {
		const rt = runtime();
		const orphansOnly = docWith([snapshotOf(ref("stale"))]);
		const { ir } = rt.apply(
			orphansOnly,
			{ type: COLLECT_UNUSED_COMMAND, retainedSnapshotKeys: new Set<string>() },
			AT,
		);
		expect("externalComponentSnapshots" in ir).toBe(false);
	});
});

describe("previewCollectUnused — honest labelling (T-034 DoD)", () => {
	it("reports ELIGIBLE keys and bytes, and what history is holding", () => {
		const preview = previewCollectUnused(
			docWith(
				[
					snapshotOf(ref("used")),
					snapshotOf(ref("stale")),
					snapshotOf(ref("held")),
				],
				{
					pageInstances: [ref("used")],
				},
			),
			new Set([snapshotKey(ref("held"))]),
		);
		expect(preview.eligibleKeys).toEqual([snapshotKey(ref("stale"))]);
		expect(preview.retainedOnlyByHistory).toEqual([snapshotKey(ref("held"))]);
		expect(preview.eligibleBytes).toBeGreaterThan(0);
	});

	it("names the field `eligibleBytes`, never `reclaimed`", () => {
		// The document is JSON a host serializes however it likes, so
		// bytes-on-disk is not ours to promise.
		const preview = previewCollectUnused(docWith([]), new Set<string>());
		expect(Object.keys(preview)).toContain("eligibleBytes");
		expect(JSON.stringify(Object.keys(preview))).not.toMatch(/reclaim/i);
	});

	it("agrees with what the command actually removes", () => {
		const before = docWith(
			[snapshotOf(ref("used")), snapshotOf(ref("stale"))],
			{ pageInstances: [ref("used")] },
		);
		const preview = previewCollectUnused(before, new Set<string>());
		const { ir } = runtime().apply(
			before,
			{ type: COLLECT_UNUSED_COMMAND, retainedSnapshotKeys: new Set<string>() },
			AT,
		);
		const removed = Object.keys(before.externalComponentSnapshots ?? {}).filter(
			(k) => !(k in (ir.externalComponentSnapshots ?? {})),
		);
		expect(removed).toEqual(preview.eligibleKeys);
	});

	it("does not mutate", () => {
		const before = docWith([snapshotOf(ref("stale"))]);
		const snap = structuredClone(before);
		previewCollectUnused(before, new Set<string>());
		expect(before).toEqual(snap);
	});
});
