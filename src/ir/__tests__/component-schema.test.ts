import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import type {
	CanvasExtension,
	CanvasUnknownNode,
} from "../../extensions/types.js";
import { validateLayoutInvariants } from "../../layout/validate.js";
import { createCanvasIR, createGroup, createText } from "../builders.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentInstanceNode,
	CanvasGroupNode,
	CanvasIR,
} from "../types.js";
import {
	CanvasComponentInstanceNodeSchema,
	CanvasIRSchema,
} from "../validators.js";

/**
 * M1-05 (plan 0023): a component-bearing document parses on BOTH schema
 * paths, unknown keys round-trip (looseObject convention), the Registry
 * key===id invariant rejects mismatches, an empty registry normalizes to
 * omission (INV-10), and — rollout safety — the component capability ids are
 * NOT honoured by this build until M6 flips the supported set.
 */

const NOW = () => "2026-07-29T00:00:00.000Z";

function makeInstance(): CanvasComponentInstanceNode & {
	vendorMark?: unknown;
} {
	return {
		id: "inst-1",
		type: "component-instance",
		transform: { x: 10, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
		bounds: { width: 200, height: 160 },
		componentId: "cmp-cta",
		overrides: {
			"prop-title": {
				kind: "text",
				value: { kind: "plain", text: "Hello again" },
			},
			"prop-bg": { kind: "color", value: "#00ff00" },
		},
		// Unknown key — must survive parse verbatim (forward-compat contract).
		vendorMark: { origin: "test" },
	};
}

function componentDoc(): CanvasIR {
	const definition: CanvasComponentDefinition & { vendorExt?: unknown } = {
		id: "cmp-cta",
		name: "CTA card",
		revision: 3,
		root: createGroup({
			id: "cta-root",
			children: [
				createText({
					id: "cta-title",
					text: "Hello",
					bounds: { width: 100, height: 20 },
				}),
			],
		}),
		properties: [
			{
				id: "prop-title",
				name: "Title",
				nodeId: "cta-title",
				kind: "text",
				targetKind: "text",
			},
			{
				id: "prop-bg",
				name: "Background",
				nodeId: "cta-root",
				kind: "color",
				targetField: "fill",
			},
		],
		vendorExt: { keep: true },
	};
	const ir = createCanvasIR({ id: "doc-components", now: NOW });
	const pageRoot = ir.pages[0]?.root as CanvasGroupNode | undefined;
	if (!pageRoot) throw new Error("fixture page missing");
	pageRoot.children.push(makeInstance());
	return { ...ir, components: { "cmp-cta": definition } };
}

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("component schemas in both unions (M1-05)", () => {
	it("static path: parses a component-bearing document and preserves unknown keys", () => {
		const parsed = CanvasIRSchema.parse(jsonClone(componentDoc()));

		const definition = parsed.components?.["cmp-cta"] as
			| (CanvasComponentDefinition & { vendorExt?: unknown })
			| undefined;
		expect(definition?.revision).toBe(3);
		expect(definition?.vendorExt).toEqual({ keep: true });
		expect(definition?.properties).toHaveLength(2);

		const parsedRoot = parsed.pages[0]?.root as CanvasGroupNode | undefined;
		const instance = parsedRoot?.children.find(
			(n) => n.type === "component-instance",
		) as (CanvasComponentInstanceNode & { vendorMark?: unknown }) | undefined;
		expect(instance?.componentId).toBe("cmp-cta");
		expect(instance?.overrides?.["prop-title"]).toEqual({
			kind: "text",
			value: { kind: "plain", text: "Hello again" },
		});
		expect(instance?.vendorMark).toEqual({ origin: "test" });
	});

	it("extended path: the SAME document parses, including a custom kind inside a Source tree", () => {
		const badgeExt: CanvasExtension = {
			id: "badge-ext",
			nodeKinds: [
				{
					kind: "x-badge",
					schema: z.looseObject({
						id: z.string().min(1),
						type: z.literal("x-badge"),
						transform: z.looseObject({
							x: z.number(),
							y: z.number(),
							rotation: z.number(),
							scaleX: z.number(),
							scaleY: z.number(),
						}),
						bounds: z.looseObject({
							width: z.number(),
							height: z.number(),
						}),
						zIndex: z.number(),
					}) as unknown as z.ZodType<CanvasUnknownNode>,
				},
			],
		};

		const doc = componentDoc();
		const definition = doc.components?.["cmp-cta"] as CanvasComponentDefinition;
		(definition.root as CanvasGroupNode).children.push({
			id: "badge-1",
			type: "x-badge",
			transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
			bounds: { width: 8, height: 8 },
			zIndex: 0,
		} as never);

		const runtime = createCanvasRuntime([badgeExt]);
		const parsed = runtime.migrate(jsonClone(doc));
		const root = parsed.components?.["cmp-cta"]?.root as CanvasGroupNode;
		expect(root.children.some((n) => n.type === ("x-badge" as never))).toBe(
			true,
		);

		// The zero-extension runtime rejects the custom kind but accepts the
		// plain component document — same behavior as the static path.
		expect(() => createCanvasRuntime().migrate(jsonClone(doc))).toThrow();
		expect(() =>
			createCanvasRuntime().migrate(jsonClone(componentDoc())),
		).not.toThrow();
	});

	it("rejects a Registry key that differs from definition.id (INV-1)", () => {
		const doc = componentDoc();
		const definition = doc.components?.["cmp-cta"] as CanvasComponentDefinition;
		const broken = {
			...doc,
			components: { "wrong-key": definition },
		};
		expect(() => CanvasIRSchema.parse(jsonClone(broken))).toThrow(/INV-1/);
	});

	it("normalizes an empty registry to omission on both paths (INV-10)", () => {
		const doc = { ...componentDoc(), components: {} };
		const parsedStatic = CanvasIRSchema.parse(jsonClone(doc));
		expect("components" in parsedStatic).toBe(false);

		const parsedExtended = createCanvasRuntime().migrate(jsonClone(doc));
		expect("components" in parsedExtended).toBe(false);
	});

	it("rejects an instance with an empty componentId", () => {
		const instance = { ...makeInstance(), componentId: "" };
		expect(() =>
			CanvasComponentInstanceNodeSchema.parse(jsonClone(instance)),
		).toThrow();
	});

	/**
	 * M6-06 FLIPPED THIS. Until M6 this build did not implement Local Components,
	 * so declaring the capability correctly routed a document to read-only preview
	 * (the M1 assertion this replaces). From M6 the resolver, editor and
	 * serializers all implement it, so the same declaration must now be honoured —
	 * a build that kept reporting "unsupported" would make every component
	 * document it can fully edit read-only.
	 */
	it("honours the component capabilities now that M6 has flipped the set", () => {
		const doc: CanvasIR = {
			...componentDoc(),
			compatibility: {
				schemaVersion: "3",
				minReaderSchemaVersion: "3",
				requiredCapabilities: [
					"components.local.v1",
					"components.overrides.v1",
				],
			},
		};
		const issues = validateLayoutInvariants(doc);
		expect(issues.some((i) => i.code === "layout-capability-unsupported")).toBe(
			false,
		);
	});

	it("still reports a capability this build genuinely does not implement", () => {
		// The flip must not blunt the gate — an unknown capability is still
		// unsupported, which is what keeps AC-010/INV-14 meaningful.
		const doc: CanvasIR = {
			...componentDoc(),
			compatibility: {
				schemaVersion: "3",
				minReaderSchemaVersion: "3",
				requiredCapabilities: ["components.remote.v1"],
			},
		};
		expect(
			validateLayoutInvariants(doc).some(
				(i) => i.code === "layout-capability-unsupported",
			),
		).toBe(true);
	});
});
