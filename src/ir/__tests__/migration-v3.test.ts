import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateLayoutInvariants } from "../../layout/validate.js";
import {
	CANVAS_LAYOUT_AUTO_CAPABILITY,
	validateCanvasIRInvariants,
} from "../invariants.js";
import type { CanvasFrameNode, CanvasIR, CanvasNode } from "../types.js";
import { CANVAS_IR_VERSION, migrateCanvasIR } from "../validators.js";
const readFixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
	);

const layoutDeclared = readFixture("v3-layout-declared");
const layoutMissingCapability = readFixture("v3-layout-missing-capability");
const unknownCapability = readFixture("v3-unknown-capability");
const v2WithUnknownKeys = readFixture("v2-with-unknown-keys");

/**
 * @file T-M1-12 — migration, capability, and round-trip fixture suite
 * (AC-001 migration, AC-010 graceful degradation, AC-013 rejection).
 *
 * The fixtures are real on-disk JSON documents rather than object literals
 * built by the builders, because half of what is under test is what happens to
 * a document this build did NOT author: unknown keys it must preserve, and a
 * capability string it must not recognise.
 */

/** Fresh deep copy, so no test can mutate a fixture another test reads. */
const load = <T>(fixture: T): T => structuredClone(fixture) as T;

/** Every node in the document, pre-order. */
function collectNodes(ir: CanvasIR): CanvasNode[] {
	const out: CanvasNode[] = [];
	const visit = (node: CanvasNode) => {
		out.push(node);
		if ("children" in node && Array.isArray(node.children)) {
			for (const child of node.children as CanvasNode[]) visit(child);
		}
	};
	for (const page of ir.pages) visit(page.root);
	return out;
}

/** Just the geometry, for byte-identity comparison across a migration. */
const geometryOf = (ir: CanvasIR) =>
	collectNodes(ir).map((n) => ({
		id: n.id,
		transform: n.transform,
		bounds: n.bounds,
	}));

describe("AC-001 — v2 migrates to v3 with no geometry change", () => {
	it("migrates the version tag and nothing else", () => {
		const source = load(v2WithUnknownKeys);
		const migrated = migrateCanvasIR(source);
		expect(migrated.version).toBe("3");
		expect(CANVAS_IR_VERSION).toBe("3");
	});

	it("leaves geometry byte-identical", () => {
		const source = load(v2WithUnknownKeys);
		const migrated = migrateCanvasIR(source);
		// Compared as JSON text, not deep-equal: this catches a 300.75 that
		// became 300.7500000001 somewhere in the pipeline, which `toEqual` on
		// numbers would also catch but which reads far less clearly on failure.
		expect(JSON.stringify(geometryOf(migrated))).toBe(
			JSON.stringify(geometryOf(source as unknown as CanvasIR)),
		);
	});

	it("preserves unknown keys at document, page, and node level", () => {
		const migrated = migrateCanvasIR(load(v2WithUnknownKeys)) as unknown as {
			vendorExtension?: { kept?: boolean };
			pages: Array<{
				pageLevelUnknown?: number;
				root: { children: Array<{ nodeLevelUnknown?: string[] }> };
			}>;
		};
		expect(migrated.vendorExtension?.kept).toBe(true);
		expect(migrated.pages[0]?.pageLevelUnknown).toBe(42);
		expect(migrated.pages[0]?.root.children[0]?.nodeLevelUnknown).toEqual([
			"a",
			"b",
		]);
	});

	it("is idempotent — re-migrating a v3 document is a no-op", () => {
		const once = migrateCanvasIR(load(v2WithUnknownKeys));
		const twice = migrateCanvasIR(structuredClone(once));
		expect(twice).toEqual(once);
		const thrice = migrateCanvasIR(structuredClone(twice));
		expect(JSON.stringify(thrice)).toBe(JSON.stringify(once));
	});

	it("does NOT fabricate a compatibility record for layout-free content", () => {
		// A migrated v2 document carries no layout intent, so claiming
		// `layout.auto.v1` would be a lie that newer readers would act on.
		const migrated = migrateCanvasIR(load(v2WithUnknownKeys));
		expect(migrated.compatibility).toBeUndefined();
		expect(validateCanvasIRInvariants(migrated)).toEqual([]);
	});
});

describe("AC-010 — an unknown capability degrades gracefully, never rejects", () => {
	it("PARSES a document requiring a capability this build does not implement", () => {
		// The fixture deliberately uses "test.future.v9", NOT layout.auto.v1 —
		// a fixture using the one capability this build knows would pass while
		// leaving the real forward-compatibility path broken.
		const doc = migrateCanvasIR(load(unknownCapability));
		expect(doc.compatibility?.requiredCapabilities).toEqual(["test.future.v9"]);
	});

	it("is flagged read-only by a level-4 diagnostic, not a schema or invariant failure", () => {
		const doc = migrateCanvasIR(load(unknownCapability));
		// Level 2 (document invariants) must stay silent...
		expect(validateCanvasIRInvariants(doc)).toEqual([]);
		// ...while level 4 reports it with the cached-geometry fallback.
		expect(validateLayoutInvariants(doc)).toContainEqual(
			expect.objectContaining({
				code: "layout-capability-unsupported",
				severity: "error",
				fallback: "cached-geometry",
			}),
		);
	});

	it("survives a full JSON round-trip with the unknown capability intact", () => {
		const doc = migrateCanvasIR(load(unknownCapability));
		const round = migrateCanvasIR(JSON.parse(JSON.stringify(doc)));
		expect(round.compatibility?.requiredCapabilities).toEqual([
			"test.future.v9",
		]);
	});
});

describe("AC-013 — layout intent without its capability is rejected", () => {
	it("reports missing-required-capability for the layout-bearing fixture", () => {
		const doc = migrateCanvasIR(load(layoutMissingCapability));
		expect(validateCanvasIRInvariants(doc)).toContainEqual(
			expect.objectContaining({
				code: "missing-required-capability",
				nodeId: "frame-1",
				pageId: "page-1",
			}),
		);
	});

	it("accepts the identical document once the capability is declared", () => {
		const doc = migrateCanvasIR(load(layoutDeclared));
		expect(validateCanvasIRInvariants(doc)).toEqual([]);
	});

	it("the two fixtures differ ONLY by the compatibility record", () => {
		// Keeps the pair honest: if they drift apart, the test above stops
		// proving that the capability declaration is what makes the difference.
		const missing = load(layoutMissingCapability) as unknown as CanvasIR;
		const declared = load(layoutDeclared) as unknown as CanvasIR;
		expect(declared.compatibility?.requiredCapabilities).toEqual([
			CANVAS_LAYOUT_AUTO_CAPABILITY,
		]);
		expect({
			...declared,
			compatibility: undefined,
			id: "",
			title: "",
		}).toEqual({ ...missing, compatibility: undefined, id: "", title: "" });
	});

	it("preserves the layout intent verbatim through migration", () => {
		const doc = migrateCanvasIR(load(layoutDeclared));
		const frame = collectNodes(doc).find(
			(n): n is CanvasFrameNode => n.id === "frame-1" && n.type === "frame",
		);
		expect(frame?.autoLayout).toEqual({
			version: 1,
			direction: "horizontal",
			padding: { top: 8, right: 8, bottom: 8, left: 8 },
			gap: 12,
			primaryAlign: "start",
			crossAlign: "center",
		});
		expect(
			collectNodes(doc).find((n) => n.id === "rect-1")?.layoutItem,
		).toEqual({ widthSizing: "fill" });
	});
});
