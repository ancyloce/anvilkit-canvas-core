import { describe, expect, it } from "vitest";
import { createCanvasIR, createFrame, createRect } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import { resolveCanvasLayout } from "../../layout/index.js";
import type { CanvasResolvedNodeRecord } from "../../layout/types.js";
import type { CanvasResolvedComponentOrigin } from "../types.js";

/**
 * M2-03 (plan 0023): `component?` is ADDITIVE — a component-free document
 * resolves with the field absent on every record, and the origin shape is
 * assignable where a resolver will write it. No required field was added
 * (the compile of this file is half the test).
 */
describe("CanvasResolvedNodeRecord.component (M2-03)", () => {
	it("stays undefined on every record of a component-free document", () => {
		let ir = createCanvasIR({
			id: "plain",
			now: () => "2026-07-29T00:00:00.000Z",
		});
		const pageRootId = ir.pages[0]?.root.id as string;
		ir = insertNode(ir, {
			parentId: pageRootId,
			node: createFrame({
				id: "f1",
				bounds: { width: 100, height: 50 },
				children: [createRect({ id: "r1", bounds: { width: 10, height: 10 } })],
			}),
			now: () => "2026-07-29T00:00:00.000Z",
		});

		const resolved = resolveCanvasLayout(ir, {});
		expect(resolved.records.size).toBeGreaterThan(0);
		for (const record of resolved.records.values()) {
			expect(record.component).toBeUndefined();
		}
	});

	it("accepts a fully-populated origin on the record type", () => {
		const origin: CanvasResolvedComponentOrigin = {
			instanceId: "inst-1",
			componentId: "cmp-cta",
			definitionNodeId: "cta-title",
			depth: 1,
		};
		const withOrigin: Pick<CanvasResolvedNodeRecord, "component"> = {
			component: origin,
		};
		expect(withOrigin.component?.depth).toBe(1);
	});
});
