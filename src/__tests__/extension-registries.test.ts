import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCommandRegistry } from "../extensions/command-registry.js";
import { createMigrationRegistry } from "../extensions/migration-registry.js";
import {
	type CanvasNodeKindDefinition,
	type CanvasUnknownNode,
	createNodeKindRegistry,
} from "../extensions/node-kind-registry.js";

interface StarNode extends CanvasUnknownNode {
	type: "star";
	points: number;
}

const starDef: CanvasNodeKindDefinition<StarNode> = {
	kind: "star",
	schema: z.looseObject({
		id: z.string(),
		type: z.literal("star"),
		transform: z.any(),
		bounds: z.any(),
		zIndex: z.number(),
		points: z.number(),
	}) as unknown as z.ZodType<StarNode>,
	create: (opts) => ({
		id: String(opts.id ?? "star-1"),
		type: "star",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 10, height: 10 },
		zIndex: 0,
		points: Number(opts.points ?? 5),
	}),
};

describe("createNodeKindRegistry", () => {
	it("registers, gets, has, lists", () => {
		const reg = createNodeKindRegistry();
		expect(reg.has("star")).toBe(false);
		reg.register(starDef);
		expect(reg.has("star")).toBe(true);
		expect(reg.get("star")?.kind).toBe("star");
		expect(reg.list().map((d) => d.kind)).toEqual(["star"]);
		expect(reg.get("nope")).toBeUndefined();
	});

	it("seeds from builtins and last register wins for a kind", () => {
		const reg = createNodeKindRegistry([starDef]);
		expect(reg.has("star")).toBe(true);
		const override = { ...starDef, isContainer: true };
		reg.register(override);
		expect(reg.get("star")?.isContainer).toBe(true);
		expect(reg.list()).toHaveLength(1);
	});

	it("create() produces a node of the kind", () => {
		const reg = createNodeKindRegistry([starDef]);
		const node = reg.get("star")?.create?.({ points: 6 });
		expect(node).toMatchObject({ type: "star", points: 6 });
	});
});

describe("createCommandRegistry", () => {
	it("registers + dispatches a custom handler", () => {
		const reg = createCommandRegistry();
		expect(reg.has("custom.noop")).toBe(false);
		reg.register({
			type: "custom.noop",
			apply: (ir) => ({ ir, inverse: { type: "custom.noop" } as never }),
		});
		expect(reg.has("custom.noop")).toBe(true);
		const handler = reg.get("custom.noop");
		expect(handler?.type).toBe("custom.noop");
	});
});

describe("createMigrationRegistry", () => {
	it("applies a multi-step chain", () => {
		const reg = createMigrationRegistry();
		reg.register({
			from: "1",
			to: "2",
			up: (raw) => ({ ...(raw as object), version: "2", a: 1 }),
		});
		reg.register({
			from: "2",
			to: "3",
			up: (raw) => ({ ...(raw as object), version: "3", b: 2 }),
		});
		const out = reg.migrate({ version: "1" }, "3") as Record<string, unknown>;
		expect(out).toEqual({ version: "3", a: 1, b: 2 });
	});

	it("returns the input unchanged when already at target", () => {
		const reg = createMigrationRegistry();
		const doc = { version: "3" };
		expect(reg.migrate(doc, "3")).toBe(doc);
	});

	it("throws on a missing step", () => {
		const reg = createMigrationRegistry();
		expect(() => reg.migrate({ version: "1" }, "2")).toThrow(/no migration/);
	});

	it("throws when the version is unreadable", () => {
		const reg = createMigrationRegistry();
		expect(() => reg.migrate({}, "2")).toThrow(/version/);
	});
});
