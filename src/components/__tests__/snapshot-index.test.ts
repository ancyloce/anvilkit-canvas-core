import { describe, expect, it } from "vitest";

import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
} from "../../ir/types.js";
import { buildExternalSnapshotIndex } from "../snapshot-index.js";

const REF: CanvasExternalComponentRef = {
	kind: "library",
	libraryId: "acme-brand",
	componentId: "button-primary",
	version: "1.4.2",
	integrity: `sha256-${"A".repeat(43)}`,
};

function snapshotOf(
	ref: CanvasExternalComponentRef,
): CanvasExternalComponentSnapshot {
	return {
		ref,
		definition: {
			id: ref.componentId,
			name: ref.componentId,
			revision: 1,
			root: {
				id: `${ref.componentId}-root`,
				type: "rect",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: { width: 10, height: 10 },
				zIndex: 0,
			},
			properties: [],
		},
		dependencies: [],
		canonicalFormatVersion: 1,
	} as CanvasExternalComponentSnapshot;
}

function registryOf(...refs: CanvasExternalComponentRef[]) {
	return Object.fromEntries(refs.map((r) => [snapshotKey(r), snapshotOf(r)]));
}

describe("buildExternalSnapshotIndex (T-015)", () => {
	it("finds a snapshot by exact ref", () => {
		const index = buildExternalSnapshotIndex(registryOf(REF));
		expect(index.get(REF)?.ref).toEqual(REF);
		expect(index.has(REF)).toBe(true);
		expect(index.size).toBe(1);
	});

	it("ignores key order in the ref, because the key is derived not stringified", () => {
		const reordered = {
			integrity: REF.integrity,
			version: REF.version,
			componentId: REF.componentId,
			libraryId: REF.libraryId,
			kind: "library",
		} as CanvasExternalComponentRef;
		expect(
			buildExternalSnapshotIndex(registryOf(REF)).get(reordered),
		).toBeDefined();
	});

	it.each([
		["libraryId", "evil-corp"],
		["componentId", "card-hero"],
		["version", "1.4.3"],
		["integrity", `sha256-${"B".repeat(43)}`],
	])("misses when %s differs", (field, value) => {
		const index = buildExternalSnapshotIndex(registryOf(REF));
		const other = { ...REF, [field]: value } as CanvasExternalComponentRef;
		expect(index.get(other)).toBeUndefined();
		expect(index.has(other)).toBe(false);
	});

	describe("never falls through to Object.prototype (T-015 acceptance)", () => {
		it.each([
			"constructor",
			"toString",
			"valueOf",
			"hasOwnProperty",
			"__proto__",
		])("getByKey(%j) is undefined, not an inherited member", (key) => {
			const index = buildExternalSnapshotIndex(registryOf(REF));
			expect(index.getByKey(key)).toBeUndefined();
		});

		it("a RAW record lookup would have returned an inherited member", () => {
			// The reason this module exists, asserted rather than described: the
			// same read against the plain persisted record is NOT undefined.
			const raw = registryOf(REF) as unknown as Record<string, unknown>;
			expect(raw.constructor).toBeDefined();
			expect(typeof raw.toString).toBe("function");
		});

		it("indexes a hostile own `__proto__` key without polluting anything", () => {
			// Built via JSON.parse: an object literal would set the prototype
			// instead of creating an own key, and the test would prove nothing.
			const registry = JSON.parse(
				JSON.stringify({ placeholder: snapshotOf(REF) }).replace(
					'"placeholder"',
					'"__proto__"',
				),
			);
			expect(Object.keys(registry)).toEqual(["__proto__"]);

			const index = buildExternalSnapshotIndex(registry);
			// It is indexed as an ordinary string key...
			expect(index.getByKey("__proto__")).toBeDefined();
			// ...and nothing leaked onto Object.prototype.
			expect(({} as Record<string, unknown>).ref).toBeUndefined();
			// A well-formed ref still misses, because "__proto__" is not its key.
			expect(index.get(REF)).toBeUndefined();
		});
	});

	it("does not index inherited properties of the registry object", () => {
		const parent = { "inherited/a/b/c": snapshotOf(REF) };
		const registry = Object.create(parent) as Record<string, unknown>;
		const index = buildExternalSnapshotIndex(registry as never);
		expect(index.size).toBe(0);
		expect(index.getByKey("inherited/a/b/c")).toBeUndefined();
	});

	it("treats an unkeyable ref as a miss rather than throwing", () => {
		// Degradation is never a throw on the render path (INV-3).
		const index = buildExternalSnapshotIndex(registryOf(REF));
		expect(index.get({ ...REF, libraryId: "" })).toBeUndefined();
		expect(
			index.get(undefined as unknown as CanvasExternalComponentRef),
		).toBeUndefined();
	});

	it("is empty and cheap for a document with no external components", () => {
		expect(buildExternalSnapshotIndex(undefined).size).toBe(0);
		expect(buildExternalSnapshotIndex({}).size).toBe(0);
		expect(buildExternalSnapshotIndex(undefined).get(REF)).toBeUndefined();
		expect(buildExternalSnapshotIndex(undefined).keys()).toEqual([]);
	});

	it("never mutates the registry it reads", () => {
		const registry = registryOf(REF);
		const before = structuredClone(registry);
		const index = buildExternalSnapshotIndex(registry);
		index.get(REF);
		index.keys();
		expect(registry).toEqual(before);
	});

	it("returns keys sorted, for deterministic diagnostics", () => {
		const refs = ["c", "a", "b"].map((id) => ({ ...REF, componentId: id }));
		const keys = buildExternalSnapshotIndex(registryOf(...refs)).keys();
		expect(keys).toEqual([...keys].sort());
		expect(keys).toHaveLength(3);
	});
});
