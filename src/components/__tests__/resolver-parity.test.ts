import { describe, expect, it } from "vitest";

import { snapshotKey } from "../../ir/snapshot-key.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasExternalComponentRef,
	CanvasExternalComponentSnapshot,
} from "../../ir/types.js";
import { createComponentResolutionCache } from "../cache.js";
import { getDefinition } from "../definition-lookup.js";
import { resolveComponentInstance } from "../resolve.js";
import { buildExternalSnapshotIndex } from "../snapshot-index.js";

/**
 * T-016 PARITY — the milestone's whole point.
 *
 * M1's exit criterion is "a headless document renders the same external
 * component online and offline". The way that is made true is by having ONE
 * resolver: everything downstream of the definition lookup is identical for a
 * local Source and a library component. These tests assert that equality
 * directly, on resolved output, rather than trusting the design note.
 *
 * Note what is NOT here: any Provider, stub or otherwise. The resolver is never
 * given one, because it must never have one — that absence IS the offline test.
 */

const REF: CanvasExternalComponentRef = {
	kind: "library",
	libraryId: "acme-brand",
	componentId: "cmp-card",
	version: "1.4.2",
	integrity: `sha256-${"A".repeat(43)}`,
};

/** One definition, used verbatim as both a local Source and a library component. */
function definition(): CanvasComponentDefinition {
	return {
		id: "cmp-card",
		name: "Card",
		revision: 7,
		root: {
			id: "card-root",
			type: "frame",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 100, height: 80 },
			zIndex: 0,
			children: [
				{
					id: "card-title",
					type: "text",
					transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
					bounds: { width: 100, height: 20 },
					zIndex: 0,
					text: "Default title",
					fontFamily: "Inter",
					fontSize: 14,
					fill: "#111111",
				},
			],
		},
		properties: [
			{
				id: "prop-title",
				name: "Title",
				nodeId: "card-title",
				kind: "text",
				targetKind: "text",
			},
		],
	} as CanvasComponentDefinition;
}

function instance(
	source: CanvasComponentInstanceNode["source"],
): CanvasComponentInstanceNode {
	return {
		id: "inst-1",
		type: "component-instance",
		transform: { x: 10, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 100, height: 80 },
		zIndex: 0,
		source,
		overrides: {
			"prop-title": { kind: "text", value: { kind: "plain", text: "Hello" } },
		},
	} as CanvasComponentInstanceNode;
}

const LOCAL_INSTANCE = () =>
	instance({ kind: "local", componentId: "cmp-card" });
const EXTERNAL_INSTANCE = () => instance(REF);

const LOCAL_REGISTRY = () => ({ "cmp-card": definition() });
const EXTERNAL_INDEX = () =>
	buildExternalSnapshotIndex({
		[snapshotKey(REF)]: {
			ref: REF,
			definition: definition(),
			dependencies: [],
			canonicalFormatVersion: 1,
		} as CanvasExternalComponentSnapshot,
	});

describe("local/external resolver parity (T-016)", () => {
	it("produces an IDENTICAL resolved subtree from either Source kind", () => {
		const local = resolveComponentInstance(LOCAL_REGISTRY(), LOCAL_INSTANCE());
		const external = resolveComponentInstance({}, EXTERNAL_INSTANCE(), {
			externalSnapshots: EXTERNAL_INDEX(),
		});

		expect(external.placeholder).toBe(false);
		expect(local.placeholder).toBe(false);
		expect(external.root).toEqual(local.root);
		expect(external.expandedNodeCount).toBe(local.expandedNodeCount);
		expect(external.issues).toEqual(local.issues);
	});

	it("produces identical provenance, including virtual ids", () => {
		const local = resolveComponentInstance(LOCAL_REGISTRY(), LOCAL_INSTANCE());
		const external = resolveComponentInstance({}, EXTERNAL_INSTANCE(), {
			externalSnapshots: EXTERNAL_INDEX(),
		});
		expect([...external.origins.keys()].sort()).toEqual(
			[...local.origins.keys()].sort(),
		);
	});

	it("applies overrides identically", () => {
		const external = resolveComponentInstance({}, EXTERNAL_INSTANCE(), {
			externalSnapshots: EXTERNAL_INDEX(),
		});
		expect(JSON.stringify(external.root)).toContain("Hello");
		expect(JSON.stringify(external.root)).not.toContain("Default title");
	});

	it("uses DIFFERENT cache keys for the two Source kinds", () => {
		// Same definition, same instance id, same overrides — but a local Source
		// and a library component are not interchangeable, and sharing one cache
		// entry between them would serve whichever resolved first.
		const local = resolveComponentInstance(LOCAL_REGISTRY(), LOCAL_INSTANCE());
		const external = resolveComponentInstance({}, EXTERNAL_INSTANCE(), {
			externalSnapshots: EXTERNAL_INDEX(),
		});
		expect(external.cacheKey).not.toBe(local.cacheKey);
		expect(local.cacheKey).toContain("local:cmp-card");
		expect(external.cacheKey).toContain("library:");
	});

	it("keys an external entry on integrity, so republished bytes never reuse it", () => {
		const cache = createComponentResolutionCache();
		const first = resolveComponentInstance({}, EXTERNAL_INSTANCE(), {
			externalSnapshots: EXTERNAL_INDEX(),
			cache,
		});

		// Same library/component/version, DIFFERENT bytes => different digest.
		const republished = { ...REF, integrity: `sha256-${"B".repeat(43)}` };
		const changed = definition();
		changed.name = "Card (republished)";
		const second = resolveComponentInstance({}, instance(republished), {
			externalSnapshots: buildExternalSnapshotIndex({
				[snapshotKey(republished)]: {
					ref: republished,
					definition: changed,
					dependencies: [],
					canonicalFormatVersion: 1,
				} as CanvasExternalComponentSnapshot,
			}),
			cache,
		});

		expect(second.cacheKey).not.toBe(first.cacheKey);
		expect(second.placeholder).toBe(false);
	});
});

describe("offline resolution (T-016 acceptance, AC-003)", () => {
	it("resolves with NO provider present at all", () => {
		// There is no provider argument to omit — the resolver has no such seam.
		// This asserts the consequence: a document with only a snapshot registry
		// resolves fully.
		const result = resolveComponentInstance({}, EXTERNAL_INSTANCE(), {
			externalSnapshots: EXTERNAL_INDEX(),
		});
		expect(result.placeholder).toBe(false);
		expect(result.issues).toEqual([]);
	});

	it("degrades to a selectable placeholder when the snapshot is absent", () => {
		const result = resolveComponentInstance({}, EXTERNAL_INSTANCE(), {
			externalSnapshots: buildExternalSnapshotIndex({}),
		});
		expect(result.placeholder).toBe(true);
		// The instance node itself is the placeholder, overrides retained (INV-3).
		expect(result.root).toEqual(EXTERNAL_INSTANCE());
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]?.code).toBe("component-snapshot-missing");
		expect(result.issues[0]?.severity).toBe("warning");
	});

	it("degrades identically when no snapshot index is supplied at all", () => {
		const withEmpty = resolveComponentInstance({}, EXTERNAL_INSTANCE(), {
			externalSnapshots: buildExternalSnapshotIndex({}),
		});
		const withNone = resolveComponentInstance({}, EXTERNAL_INSTANCE());
		expect(withNone.placeholder).toBe(true);
		expect(withNone.issues).toEqual(withEmpty.issues);
	});

	it("reports a MISSING SNAPSHOT distinctly from a missing local Source", () => {
		// Different remedies: re-fetch versus restore a Source. Collapsing them
		// would leave the Libraries panel unable to offer recovery.
		const external = resolveComponentInstance({}, EXTERNAL_INSTANCE());
		const local = resolveComponentInstance({}, LOCAL_INSTANCE());
		expect(external.issues[0]?.code).toBe("component-snapshot-missing");
		expect(local.issues[0]?.code).toBe("component-source-missing");
	});

	it("names the library component in its diagnostic without leaking the digest", () => {
		const result = resolveComponentInstance({}, EXTERNAL_INSTANCE());
		const message = result.issues[0]?.message ?? "";
		expect(message).toContain("acme-brand/cmp-card@1.4.2");
		expect(message).not.toContain("sha256");
	});
});

describe("getDefinition (TD §10)", () => {
	it("resolves a local Source", () => {
		const lookup = getDefinition(
			{ kind: "local", componentId: "cmp-card" },
			LOCAL_REGISTRY(),
			undefined,
		);
		expect(lookup.kind).toBe("local");
		expect(lookup.kind === "local" && lookup.sourceKey).toBe("local:cmp-card");
	});

	it("resolves an external Source from the snapshot index", () => {
		const lookup = getDefinition(REF, {}, EXTERNAL_INDEX());
		expect(lookup.kind).toBe("external");
		if (lookup.kind !== "external") return;
		expect(lookup.state.kind).toBe("resolved");
		expect(lookup.definition.id).toBe("cmp-card");
	});

	it.each([
		[
			"local-missing",
			{ kind: "local" as const, componentId: "nope" },
			undefined,
		],
		["snapshot-missing", REF, buildExternalSnapshotIndex({})],
	])("reports %s", (reason, source, index) => {
		const lookup = getDefinition(source, {}, index);
		expect(lookup.kind).toBe("unresolved");
		expect(lookup.kind === "unresolved" && lookup.reason).toBe(reason);
	});

	it("reports a malformed ref as unkeyable, not as a plain miss", () => {
		const lookup = getDefinition(
			{ ...REF, libraryId: "" },
			{},
			EXTERNAL_INDEX(),
		);
		expect(lookup.kind === "unresolved" && lookup.reason).toBe("unkeyable");
	});

	it("never confuses a local and a library component sharing one id", () => {
		// Both are named `cmp-card`. Resolving one must not return the other.
		const localOnly = getDefinition(REF, LOCAL_REGISTRY(), undefined);
		expect(localOnly.kind).toBe("unresolved");

		const externalOnly = getDefinition(
			{ kind: "local", componentId: "cmp-card" },
			{},
			EXTERNAL_INDEX(),
		);
		expect(externalOnly.kind).toBe("unresolved");
	});
});
