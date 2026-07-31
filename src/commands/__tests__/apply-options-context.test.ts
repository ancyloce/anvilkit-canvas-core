import { describe, expect, it } from "vitest";

import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import { createCanvasIR, createRect } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR } from "../../ir/types.js";
import { applyCommand } from "../runtime.js";
import type { CommandApplyOptions } from "../types.js";

/**
 * T-035 — one command-context seam, not a parallel type.
 *
 * The two things worth proving are that a new option **propagates into every
 * sub-command of a batch** (so a caller cannot get half-contextualized
 * behaviour) and that **absence behaves exactly as today** (so every existing
 * caller is unaffected).
 */

function doc(): CanvasIR {
	const base = createCanvasIR({ id: "doc", now: () => "t0" });
	return insertNode(base, {
		parentId: base.pages[0]?.root.id as string,
		node: createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
		now: () => "t0",
	});
}

describe("CommandApplyOptions carries the context (T-035)", () => {
	it("accepts `idFactory` without disturbing anything", () => {
		const options: CommandApplyOptions = {
			now: () => "t0",
			idFactory: () => "fixed-id",
		};
		// ONE base document: two `doc()` calls mint different random page ids, so
		// comparing independently-created documents would compare the id generator.
		const base = doc();
		const cmd = {
			type: "node.update",
			nodeId: "r1",
			kind: "rect",
			patch: { name: "x" },
		} as const;
		const withOption = applyCommand(base, cmd, options);
		const without = applyCommand(base, cmd, { now: () => "t0" });
		// Absent context behaves EXACTLY as today (T-035 acceptance).
		expect(withOption.ir).toEqual(without.ir);
	});

	it("propagates the WHOLE options object into every sub-command of a batch", () => {
		// Proven through `enforceLocked`, which has real in-tree behaviour: a
		// locked node inside a batch must throw, which can only happen if the
		// option reached the sub-command.
		const base = doc();
		const locked = applyCommand(
			base,
			{ type: "node.update", nodeId: "r1", kind: "rect", patch: { locked: true } },
			{ now: () => "t0" },
		).ir;

		expect(() =>
			applyCommand(
				locked,
				{
					type: "batch",
					commands: [
						{
							type: "node.update",
							nodeId: "r1",
							kind: "rect",
							patch: { name: "nope" },
						},
					],
				},
				{ now: () => "t0", enforceLocked: true },
			),
		).toThrow();

		// …and without the option the same batch applies, so the throw above is
		// the option arriving rather than an unrelated failure.
		expect(() =>
			applyCommand(
				locked,
				{
					type: "batch",
					commands: [
						{ type: "node.update", nodeId: "r1", kind: "rect", patch: { name: "ok" } },
					],
				},
				{ now: () => "t0" },
			),
		).not.toThrow();
	});

	it("reaches an EXTENSION command handler unchanged", () => {
		// The seam has to work for the library commands too, which dispatch
		// through the extension registry rather than the built-in switch.
		let seen: CommandApplyOptions | undefined;
		const runtime = createCanvasRuntime([
			{
				id: "probe",
				commands: [
					{
						type: "probe.noop",
						apply: (ir, _cmd, options) => {
							seen = options;
							return { ir, inverse: { type: "probe.noop" } };
						},
					},
				],
			},
		]);

		const idFactory = () => "from-context";
		runtime.apply(
			doc(),
			{ type: "probe.noop" },
			{
				now: () => "t0",
				idFactory,
			},
		);

		expect(seen?.idFactory).toBe(idFactory);
		expect(seen?.now?.()).toBe("t0");
	});

	it("keeps the batch all-or-nothing when the context is present", () => {
		const base = doc();
		const before = structuredClone(base);
		expect(() =>
			applyCommand(
				base,
				{
					type: "batch",
					commands: [
						{ type: "node.update", nodeId: "r1", kind: "rect", patch: { name: "ok" } },
						{ type: "node.update", nodeId: "missing", kind: "rect", patch: { name: "x" } },
					],
				},
				{ now: () => "t0", idFactory: () => "x" },
			),
		).toThrow();
		expect(base).toEqual(before);
	});
});
