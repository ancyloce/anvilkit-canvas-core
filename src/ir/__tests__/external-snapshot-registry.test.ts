import { describe, expect, it } from "vitest";

import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import { MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT } from "../../limits.js";
import { createCanvasIR } from "../builders.js";
import { snapshotKey } from "../snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
	CanvasIR,
} from "../types.js";
import {
	CanvasExternalComponentSnapshotRegistrySchema,
	CanvasIRSchema,
} from "../validators.js";

/**
 * T-014 — `CanvasIR.externalComponentSnapshots`.
 *
 * The load-bearing assertion here is `key === snapshotKey(entry.ref)`. Until the
 * key codec moved down to `ir/` (rank 1) it was not expressible where the schema
 * lives — that was M0 follow-up #1 — so these cases also stand as the proof that
 * the relocation actually bought the check it was for.
 */

const REF: CanvasExternalComponentRef = {
	kind: "library",
	libraryId: "acme-brand",
	componentId: "button-primary",
	version: "1.4.2",
	integrity: `sha256-${"A".repeat(43)}`,
};

function definitionOf(id: string) {
	return {
		id,
		name: "Primary Button",
		revision: 1,
		root: {
			id: `${id}-root`,
			type: "rect" as const,
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 120, height: 40 },
			zIndex: 0,
			fill: "#2563eb",
		},
		properties: [],
	};
}

function snapshotOf(
	ref: CanvasExternalComponentRef = REF,
): CanvasExternalComponentSnapshot {
	return {
		ref,
		definition: definitionOf(ref.componentId),
		dependencies: [],
		canonicalFormatVersion: 1,
	} as CanvasExternalComponentSnapshot;
}

function registryOf(...snapshots: CanvasExternalComponentSnapshot[]) {
	return Object.fromEntries(snapshots.map((s) => [snapshotKey(s.ref), s]));
}

function docWith(registry: Record<string, unknown>): Record<string, unknown> {
	const ir = createCanvasIR({ id: "doc", now: () => "t0" });
	return { ...ir, externalComponentSnapshots: registry } as Record<
		string,
		unknown
	>;
}

describe("external snapshot registry schema (T-014)", () => {
	it("accepts a well-keyed snapshot", () => {
		const parsed = CanvasExternalComponentSnapshotRegistrySchema.parse(
			registryOf(snapshotOf()),
		);
		expect(Object.keys(parsed)).toEqual([snapshotKey(REF)]);
	});

	it("REJECTS a snapshot filed under another component's key", () => {
		// The whole point: every field validates, but the registry would serve
		// `button-primary`'s bytes to anyone asking for `card-hero` (TD §22.1).
		const other: CanvasExternalComponentRef = {
			...REF,
			componentId: "card-hero",
		};
		const bad = { [snapshotKey(other)]: snapshotOf(REF) };

		const result = CanvasExternalComponentSnapshotRegistrySchema.safeParse(bad);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain(
			"must equal snapshotKey(entry.ref)",
		);
	});

	it.each([
		["libraryId", "evil-corp"],
		["version", "9.9.9"],
		["integrity", `sha256-${"B".repeat(43)}`],
	])("rejects a key differing only in %s", (field, value) => {
		const other = { ...REF, [field]: value } as CanvasExternalComponentRef;
		const result = CanvasExternalComponentSnapshotRegistrySchema.safeParse({
			[snapshotKey(other)]: snapshotOf(REF),
		});
		expect(result.success).toBe(false);
	});

	it.each(["__proto__", "constructor", "prototype", "a/b/c", "", "a/b/c/d/e"])(
		"rejects %j, which is not a snapshot key at all",
		(key) => {
			// Built through JSON.parse, NOT an object literal: `{ ["__proto__"]: x }`
			// sets the prototype instead of an own property, so the literal form
			// would hand the schema an EMPTY registry and pass vacuously.
			const registry = JSON.parse(
				JSON.stringify({ placeholder: snapshotOf() }).replace(
					'"placeholder"',
					JSON.stringify(key),
				),
			);
			expect(Object.keys(registry)).toEqual([key]);
			expect(
				CanvasExternalComponentSnapshotRegistrySchema.safeParse(registry)
					.success,
			).toBe(false);
		},
	);

	it("caps the number of stored snapshots", () => {
		const many: Record<string, CanvasExternalComponentSnapshot> = {};
		for (let i = 0; i <= MAX_EXTERNAL_SNAPSHOTS_PER_DOCUMENT; i += 1) {
			const ref = { ...REF, componentId: `c-${i}` };
			many[snapshotKey(ref)] = snapshotOf(ref);
		}
		const result =
			CanvasExternalComponentSnapshotRegistrySchema.safeParse(many);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result.error?.issues)).toContain("max");
	});

	it("keeps unknown keys on a snapshot (CON-5), unlike the strict envelope", () => {
		const withExtra = {
			[snapshotKey(REF)]: { ...snapshotOf(), vendorField: { keep: true } },
		};
		const parsed =
			CanvasExternalComponentSnapshotRegistrySchema.parse(withExtra);
		expect(
			(parsed[snapshotKey(REF)] as unknown as { vendorField?: unknown })
				.vendorField,
		).toEqual({ keep: true });
	});
});

describe("CanvasIR carries the registry (T-014)", () => {
	it("round-trips a snapshot-bearing document on both schema paths", () => {
		const doc = docWith(registryOf(snapshotOf()));
		const staticParsed = CanvasIRSchema.parse(structuredClone(doc));
		const extendedParsed = createCanvasRuntime().migrate(structuredClone(doc));
		expect(staticParsed.externalComponentSnapshots).toEqual(
			doc.externalComponentSnapshots,
		);
		expect(extendedParsed).toEqual(staticParsed);
	});

	it("normalizes an EMPTY registry to omission (INV-10)", () => {
		// A document that admitted and then removed every external component must
		// be indistinguishable from one that never had any — otherwise `{}` and
		// absent diverge and every equality check downstream has to know both.
		const parsed = CanvasIRSchema.parse(docWith({}));
		expect("externalComponentSnapshots" in parsed).toBe(false);
		expect(
			"externalComponentSnapshots" in
				(createCanvasRuntime().migrate(docWith({})) as CanvasIR),
		).toBe(false);
	});

	it("is absent on a document that uses no external components", () => {
		const plain = createCanvasIR({ id: "doc", now: () => "t0" });
		const parsed = CanvasIRSchema.parse(structuredClone(plain));
		expect("externalComponentSnapshots" in parsed).toBe(false);
		// Structurally identical to a document written before the field existed.
		// Compared with `toEqual`, not stringify: Zod reorders keys on parse, and
		// key order is not part of the value — the same trap `componentSourceRefsEqual`
		// exists to avoid.
		expect(parsed).toEqual(plain);
	});

	it("rejects a document whose registry is mis-keyed, rather than loading it", () => {
		const other = { ...REF, libraryId: "evil-corp" };
		const doc = docWith({ [snapshotKey(other)]: snapshotOf(REF) });
		expect(() => CanvasIRSchema.parse(doc)).toThrow();
		expect(() => createCanvasRuntime().migrate(doc)).toThrow();
	});
});
