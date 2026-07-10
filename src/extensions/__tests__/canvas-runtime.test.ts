import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCanvasIR, createPage, createRect } from "../../ir/builders.js";
import { insertNode } from "../../ir/mutations.js";
import type { CanvasIR } from "../../ir/types.js";
import { CanvasIRSchema, CanvasNodeSchema } from "../../ir/validators.js";
import {
	type CanvasExtension,
	createCanvasRuntime,
} from "../canvas-runtime.js";
import type {
	CanvasNodeKindDefinition,
	CanvasUnknownNode,
} from "../node-kind-registry.js";

function fixtureIR(extra?: CanvasUnknownNode): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({ id: "doc", title: "t", pages: [page] });
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createRect({ id: "r1", bounds: { width: 10, height: 10 } }),
	});
	if (extra) {
		ir = insertNode(ir, { parentId: page.root.id, node: extra as never });
	}
	return ir;
}

interface StarNode extends CanvasUnknownNode {
	type: "star";
	points: number;
}

const starDef: CanvasNodeKindDefinition<StarNode> = {
	kind: "star",
	schema: z.looseObject({
		id: z.string().min(1),
		name: z.string().optional(),
		transform: z.looseObject({
			x: z.number(),
			y: z.number(),
			rotation: z.number(),
			scaleX: z.number(),
			scaleY: z.number(),
		}),
		bounds: z.looseObject({ width: z.number(), height: z.number() }),
		zIndex: z.number(),
		type: z.literal("star"),
		points: z.number(),
	}) as unknown as z.ZodType<StarNode>,
};

const starExt: CanvasExtension = { id: "star-ext", nodeKinds: [starDef] };

function makeStar(): StarNode {
	return {
		id: "s1",
		type: "star",
		transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 20, height: 20 },
		zIndex: 0,
		points: 5,
	};
}

describe("createCanvasRuntime — default (no extensions)", () => {
	it("returns the STATIC schemas by identity (byte-identical default path)", () => {
		const rt = createCanvasRuntime();
		expect(rt.nodeSchema).toBe(CanvasNodeSchema);
		expect(rt.irSchema).toBe(CanvasIRSchema);
	});

	it("seeds the registry with all built-in kinds", () => {
		const rt = createCanvasRuntime();
		for (const k of [
			"group",
			"rect",
			"ellipse",
			"line",
			"path",
			"text",
			"image",
			"ai-placeholder",
		]) {
			expect(rt.nodeKinds.has(k)).toBe(true);
		}
		expect(rt.nodeKinds.has("star")).toBe(false);
	});

	it("parses an existing IR identically to the static schema", () => {
		const ir = fixtureIR();
		const rt = createCanvasRuntime();
		expect(rt.irSchema.parse(ir)).toEqual(CanvasIRSchema.parse(ir));
	});
});

describe("createCanvasRuntime — with a custom node kind", () => {
	it("registers the custom kind and rebuilds a fresh schema pair", () => {
		const rt = createCanvasRuntime([starExt]);
		expect(rt.nodeKinds.has("star")).toBe(true);
		expect(rt.nodeSchema).not.toBe(CanvasNodeSchema);
		expect(rt.irSchema).not.toBe(CanvasIRSchema);
	});

	it("parses a custom node where the static union rejects it", () => {
		const rt = createCanvasRuntime([starExt]);
		expect(rt.nodeSchema.parse(makeStar())).toMatchObject({
			type: "star",
			points: 5,
		});
		// The closed static union has no "star" member.
		expect(() => CanvasNodeSchema.parse(makeStar())).toThrow();
	});

	it("accepts an IR whose page contains a custom node", () => {
		const ir = fixtureIR(makeStar());
		const rt = createCanvasRuntime([starExt]);
		expect(() => rt.irSchema.parse(ir)).not.toThrow();
		// Same IR fails the static schema (star is unknown to the closed union).
		expect(() => CanvasIRSchema.parse(ir)).toThrow();
	});

	it("still parses built-in nodes in the extended runtime", () => {
		const rt = createCanvasRuntime([starExt]);
		expect(() => rt.irSchema.parse(fixtureIR())).not.toThrow();
	});
});

describe("createCanvasRuntime — command dispatch", () => {
	it("routes built-in commands through applyCommand (with a real inverse)", () => {
		const ir = fixtureIR();
		const rt = createCanvasRuntime();
		const { ir: next, inverse } = rt.apply(ir, {
			type: "node.move",
			nodeId: "r1",
			from: { x: 0, y: 0 },
			to: { x: 40, y: 0 },
		});
		expect(next.pages[0]?.root.children[0]?.transform.x).toBe(40);
		expect(inverse).toMatchObject({ type: "node.move", nodeId: "r1" });
	});

	it("dispatches a custom command to its registered handler", () => {
		const ir = fixtureIR();
		const ext: CanvasExtension = {
			id: "tag-ext",
			commands: [
				{
					type: "custom.tag",
					apply: (cur) => ({
						ir: { ...cur, title: "tagged" },
						inverse: { type: "custom.untag" } as never,
					}),
				},
			],
		};
		const rt = createCanvasRuntime([ext]);
		const { ir: next } = rt.apply(ir, { type: "custom.tag" });
		expect(next.title).toBe("tagged");
	});

	it("does not let an extension shadow a built-in command type", () => {
		const ir = fixtureIR();
		const ext: CanvasExtension = {
			id: "evil-ext",
			commands: [
				{
					type: "node.move",
					apply: () => {
						throw new Error("handler should never run for a built-in type");
					},
				},
			],
		};
		const rt = createCanvasRuntime([ext]);
		expect(() =>
			rt.apply(ir, {
				type: "node.move",
				nodeId: "r1",
				from: { x: 0, y: 0 },
				to: { x: 1, y: 0 },
			}),
		).not.toThrow();
	});

	it("throws for an unknown command type with no handler", () => {
		const rt = createCanvasRuntime();
		expect(() => rt.apply(fixtureIR(), { type: "custom.unknown" })).toThrow(
			/No command handler/,
		);
	});
});

describe("createCanvasRuntime — migrate", () => {
	it("validates an already-current IR (default runtime)", () => {
		const rt = createCanvasRuntime();
		const ir = fixtureIR();
		expect(rt.migrate(ir)).toEqual(ir);
	});

	it("default runtime migrates a v1 document to v2 (built-in seed)", () => {
		const rt = createCanvasRuntime();
		const v1 = { ...fixtureIR(), version: "1", experimental: true };
		const migrated = rt.migrate(v1);
		expect(migrated.version).toBe("2");
		expect(
			(migrated as unknown as { experimental?: boolean }).experimental,
		).toBe(true);
	});

	it("default runtime rejects an unknown version (no migration path)", () => {
		const rt = createCanvasRuntime();
		expect(() => rt.migrate({ ...fixtureIR(), version: "0" })).toThrow();
	});

	it("applies a registered migration chain then validates", () => {
		const ext: CanvasExtension = {
			id: "mig-ext",
			migrations: [
				{
					from: "0",
					to: "1",
					up: (raw) => ({ ...(raw as object), version: "1" }),
				},
			],
		};
		const rt = createCanvasRuntime([ext]);
		const old = { ...fixtureIR(), version: "0" };
		// Extension step 0→1 chains into the built-in 1→2.
		const migrated = rt.migrate(old);
		expect(migrated.version).toBe("2");
	});
});

describe("createCanvasRuntime — built-in kind protection", () => {
	it("rejects an extension that registers a built-in node kind", () => {
		const rectShadow: CanvasExtension = {
			id: "hostile",
			nodeKinds: [
				{
					kind: "rect",
					schema: z.looseObject({
						id: z.string(),
						type: z.literal("rect"),
					}) as unknown as z.ZodType<CanvasUnknownNode>,
				},
			],
		};
		expect(() => createCanvasRuntime([rectShadow])).toThrowError(
			/built-in kinds cannot be shadowed/,
		);
	});

	it("rejects two extensions claiming the same custom kind", () => {
		const kindDef: CanvasNodeKindDefinition = {
			kind: "sticker",
			schema: z.looseObject({
				id: z.string(),
				type: z.literal("sticker"),
			}) as unknown as z.ZodType<CanvasUnknownNode>,
		};
		const a: CanvasExtension = { id: "a", nodeKinds: [kindDef] };
		const b: CanvasExtension = { id: "b", nodeKinds: [{ ...kindDef }] };
		expect(() => createCanvasRuntime([a, b])).toThrowError(
			/already registered by another extension/,
		);
	});
});
