import { describe, expect, it } from "vitest";
import { createCanvasRuntime } from "../../extensions/canvas-runtime.js";
import type { CanvasIR } from "../../ir/types.js";
import { CanvasIRSchema } from "../../ir/validators.js";

/**
 * M1-13 golden round-trip (plan 0023, INV-8): ONE handcrafted document
 * exercising every override type, an orphan override, a nested instance, and
 * unknown keys at every level — byte-preserved through both schema paths.
 * The generated-document property suite lives in
 * `src/__tests__/property-roundtrips.test.ts`; this golden is the readable,
 * exact-shape record of what "round-trips" means.
 */

const GOLDEN: Record<string, unknown> = {
	version: "3",
	id: "golden-components",
	title: "Golden",
	documentKind: "design",
	pages: [
		{
			id: "page-1",
			size: { width: 200, height: 200, unit: "px" },
			background: { kind: "solid", value: "#ffffff" },
			root: {
				id: "root",
				type: "group",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: { width: 200, height: 200 },
				zIndex: 0,
				children: [
					{
						id: "inst-1",
						type: "component-instance",
						transform: { x: 10, y: 10, rotation: 0, scaleX: 1, scaleY: 1 },
						bounds: { width: 100, height: 80 },
						zIndex: 0,
						componentId: "cmp-card",
						overrides: {
							"prop-title": {
								kind: "text",
								value: { kind: "plain", text: "Golden title" },
							},
							"prop-body": {
								kind: "text",
								value: {
									kind: "rich",
									paragraphs: [
										{
											spans: [
												{ text: "Rich ", fontWeight: "700" },
												{ text: "body" },
											],
										},
									],
								},
							},
							"prop-media": { kind: "image", assetId: "asset-1" },
							"prop-bg": { kind: "color", value: "#ff0000" },
							"prop-badge": { kind: "visibility", visible: false },
							// ORPHAN: no such property on cmp-card — retained
							// verbatim, never applied, never reassigned (TD §10.3).
							"prop-ghost": { kind: "visibility", visible: true },
						},
						vendorInstance: { keep: "instance" },
					},
				],
			},
		},
	],
	assets: {
		"asset-1": { id: "asset-1", uri: "https://x/img.png" },
	},
	metadata: { createdAt: "t0", updatedAt: "t0" },
	compatibility: {
		schemaVersion: "3",
		minReaderSchemaVersion: "3",
		requiredCapabilities: ["components.local.v1", "components.overrides.v1"],
	},
	components: {
		"cmp-card": {
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
						vendorNode: { keep: "node" },
					},
					{
						id: "card-nested",
						type: "component-instance",
						transform: { x: 0, y: 40, rotation: 0, scaleX: 1, scaleY: 1 },
						bounds: { width: 40, height: 20 },
						zIndex: 0,
						componentId: "cmp-button",
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
					vendorProp: { keep: "prop" },
				},
			],
			vendorDefinition: { keep: "definition" },
		},
		"cmp-button": {
			id: "cmp-button",
			name: "Button",
			revision: 2,
			root: {
				id: "button-root",
				type: "rect",
				transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
				bounds: { width: 40, height: 20 },
				zIndex: 0,
				fill: "#0000ff",
			},
			properties: [],
		},
	},
	vendorDocument: { keep: "document" },
};

function jsonClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

describe("component schema golden round-trip (M1-13, INV-8)", () => {
	it("static path: byte-preserves the golden document", () => {
		const parsed = CanvasIRSchema.parse(jsonClone(GOLDEN));
		expect(parsed).toEqual(GOLDEN);
	});

	it("extended path (zero-extension runtime): identical result", () => {
		const migrated = createCanvasRuntime().migrate(jsonClone(GOLDEN));
		expect(migrated).toEqual(GOLDEN);
	});

	it("parsing is idempotent across both paths", () => {
		const once = CanvasIRSchema.parse(jsonClone(GOLDEN));
		const twice = CanvasIRSchema.parse(jsonClone(once));
		expect(twice).toEqual(once);
		const runtimeOnce = createCanvasRuntime().migrate(jsonClone(GOLDEN));
		expect(CanvasIRSchema.parse(jsonClone(runtimeOnce))).toEqual(
			runtimeOnce as CanvasIR,
		);
	});
});
