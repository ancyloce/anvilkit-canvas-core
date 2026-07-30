import { describe, expect, it } from "vitest";
import { createComponentInstance } from "../../ir/builders.js";
import type {
	CanvasGroupNode,
	CanvasIR,
	CanvasTransform,
} from "../../ir/types.js";
import { resolveCanvasLayout } from "../../layout/resolve.js";
import { resolveCanvasDocument } from "../../layout/resolve-document.js";
import { serializeDocumentToPdf } from "../pdf.js";
import { serializePageToSvg } from "../svg.js";

/**
 * M1-09 (plan 0023): a raw `component-instance` node reaching a serializer
 * is SKIPPED with a typed warning — never silently dropped, and never
 * misreported as an unregistered extension kind. Resolved-document
 * serialization (which actually expands instances) lands in M6.
 */

const identity: CanvasTransform = {
	x: 0,
	y: 0,
	rotation: 0,
	scaleX: 1,
	scaleY: 1,
};

function docWithInstance(): CanvasIR {
	const root: CanvasGroupNode = {
		id: "root",
		type: "group",
		transform: identity,
		bounds: { width: 0, height: 0 },
		zIndex: 0,
		children: [
			createComponentInstance({
				id: "inst-1",
				bounds: { width: 20, height: 20 },
				componentId: "cmp-cta",
			}),
		],
	};
	return {
		version: "3",
		id: "doc-instance",
		title: "Instance fixture",
		pages: [
			{
				id: "page-1",
				size: { width: 100, height: 100, unit: "px" },
				background: { kind: "solid", value: "#fff" },
				root,
			},
		],
		assets: {},
		metadata: { createdAt: "t0", updatedAt: "t0" },
	};
}

describe("raw component-instance serialization (M1-09)", () => {
	it("SVG skips the node with COMPONENT_INSTANCE_UNRESOLVED, not UNKNOWN_KIND_SKIPPED", async () => {
		const { svg, warnings } = await serializePageToSvg(docWithInstance(), 0);
		expect(
			warnings.some(
				(w) =>
					w.code === "COMPONENT_INSTANCE_UNRESOLVED" && w.nodeId === "inst-1",
			),
		).toBe(true);
		expect(warnings.some((w) => w.code === "UNKNOWN_KIND_SKIPPED")).toBe(false);
		expect(svg).not.toContain("inst-1");
	});

	it("PDF flags a page containing instances once", async () => {
		const { warnings } = await serializeDocumentToPdf(docWithInstance(), {
			rasters: [],
		});
		expect(
			warnings.filter((w) => w.code === "COMPONENT_INSTANCE_UNRESOLVED"),
		).toHaveLength(1);
		expect(
			warnings.find((w) => w.code === "COMPONENT_INSTANCE_UNRESOLVED")?.pageId,
		).toBe("page-1");
	});
});

/**
 * M6-02: PDF embeds a raster the caller rendered, so it can only report
 * "unverified" — unless the caller hands over the resolution that raster came
 * from. That evidence is structural, never a self-asserted flag.
 */
describe("PDF component-resolution evidence (M6-02)", () => {
	function resolvableDoc(): CanvasIR {
		const doc = docWithInstance();
		return {
			...doc,
			components: {
				"cmp-cta": {
					id: "cmp-cta",
					name: "CTA",
					revision: 1,
					properties: [],
					root: {
						id: "cta-root",
						type: "rect",
						transform: identity,
						bounds: { width: 20, height: 20 },
						zIndex: 0,
						fill: "#123456",
					},
				},
			},
		} as CanvasIR;
	}

	it("suppresses the warning when a composed resolution covers the page", async () => {
		const ir = resolvableDoc();
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [],
			resolvedDocument: resolveCanvasDocument(ir, {}),
		});
		expect(
			warnings.some((w) => w.code === "COMPONENT_INSTANCE_UNRESOLVED"),
		).toBe(false);
	});

	it("still warns for a LAYOUT-only resolution — it proves nothing about expansion", async () => {
		const ir = resolvableDoc();
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [],
			// `resolveCanvasLayout` leaves the instance node in `source`, so the
			// raster it produced would have shown a placeholder, not the component.
			resolvedDocument: resolveCanvasLayout(ir, {}),
		});
		expect(
			warnings.some((w) => w.code === "COMPONENT_INSTANCE_UNRESOLVED"),
		).toBe(true);
	});

	it("still warns when the resolution covers a DIFFERENT page", async () => {
		const ir = resolvableDoc();
		const { warnings } = await serializeDocumentToPdf(ir, {
			rasters: [],
			resolvedDocument: resolveCanvasDocument(ir, { pageIds: ["nope"] }),
		});
		expect(
			warnings.some((w) => w.code === "COMPONENT_INSTANCE_UNRESOLVED"),
		).toBe(true);
	});
});
