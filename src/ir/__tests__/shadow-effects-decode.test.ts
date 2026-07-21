import { describe, expect, it } from "vitest";
import { createCanvasIR, createPage } from "../builders.js";
import { insertNode } from "../mutations.js";
import type { CanvasIR, CanvasNode, CanvasRectNode } from "../types.js";
import { CANVAS_IR_VERSION, migrateCanvasIR } from "../validators.js";

/**
 * PRD 0012 §9.4 reconciliation (decision record:
 * docs/architecture/shadow-effects-normalization-decision.md in this
 * package): legacy `shadow` is NOT structurally rewritten to `effects[]` at
 * the decode boundary and `CANVAS_IR_VERSION` stays "2". These tests pin the
 * decode-boundary contract that decision depends on:
 *
 * 1. migration is non-structural — `shadow` survives decode verbatim, no
 *    `effects` is injected;
 * 2. decode is idempotent/stable across round trips (migrate ∘ JSON ∘
 *    migrate = migrate);
 * 3. unknown keys are preserved through the v1→v2 upgrade at node level;
 * 4. documents holding BOTH fields keep both through decode (precedence is
 *    resolved at read time by `resolveNodeEffects`, never by rewriting).
 */

const LEGACY_SHADOW = { color: "#000000", blur: 4, offsetX: 2, offsetY: 2 };

function rectWith(extra: Record<string, unknown>): CanvasRectNode {
	return {
		id: "r1",
		type: "rect",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 10, height: 10 },
		zIndex: 0,
		fill: "#ff0000",
		...extra,
	} as CanvasRectNode;
}

function irWith(node: CanvasNode, version?: string): unknown {
	const page = createPage({ id: "p1" });
	const ir = createCanvasIR({ id: "ir-1", title: "t", pages: [page] });
	const withNode = insertNode(ir, { parentId: page.root.id, node });
	return version === undefined ? withNode : { ...withNode, version };
}

function firstChild(ir: CanvasIR): Record<string, unknown> {
	return ir.pages[0]?.root.children[0] as unknown as Record<string, unknown>;
}

describe("shadow→effects decode boundary (§9.4 normalization decision)", () => {
	it("a v1 shadow-only document decodes to v2 with `shadow` verbatim and NO injected `effects`", () => {
		const out = migrateCanvasIR(
			irWith(rectWith({ shadow: LEGACY_SHADOW }), "1"),
		);
		expect(out.version).toBe(CANVAS_IR_VERSION);
		const node = firstChild(out);
		expect(node.shadow).toEqual(LEGACY_SHADOW);
		expect(node).not.toHaveProperty("effects");
	});

	it("decode is stable: migrate(JSON round trip(migrate(x))) deep-equals migrate(x)", () => {
		const once = migrateCanvasIR(
			irWith(rectWith({ shadow: LEGACY_SHADOW }), "1"),
		);
		const twice = migrateCanvasIR(JSON.parse(JSON.stringify(once)));
		expect(twice).toEqual(once);
	});

	it("a document holding BOTH fields keeps both through decode (no rewrite)", () => {
		const out = migrateCanvasIR(
			irWith(
				rectWith({
					shadow: LEGACY_SHADOW,
					effects: [{ type: "blur", radius: 6 }],
				}),
			),
		);
		const node = firstChild(out);
		expect(node.shadow).toEqual(LEGACY_SHADOW);
		expect(node.effects).toEqual([{ type: "blur", radius: 6 }]);
	});

	it("an explicit empty `effects` array survives decode (it means 'no effects')", () => {
		const out = migrateCanvasIR(
			irWith(rectWith({ shadow: LEGACY_SHADOW, effects: [] })),
		);
		const node = firstChild(out);
		expect(node.effects).toEqual([]);
		expect(node.shadow).toEqual(LEGACY_SHADOW);
	});

	it("node-level unknown keys survive the v1→v2 upgrade next to a legacy shadow", () => {
		const out = migrateCanvasIR(
			irWith(
				rectWith({ shadow: LEGACY_SHADOW, futureField: { nested: true } }),
				"1",
			),
		);
		const node = firstChild(out);
		expect(node.futureField).toEqual({ nested: true });
		expect(node.shadow).toEqual(LEGACY_SHADOW);
	});
});
