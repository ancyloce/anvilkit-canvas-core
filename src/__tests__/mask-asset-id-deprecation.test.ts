import { describe, expect, it } from "vitest";
import {
	CANVAS_CLIPBOARD_VERSION,
	type CanvasClipboardPayload,
	materializeClipboardNodes,
} from "../clipboard/payload.js";
import {
	createCanvasIR,
	createGroup,
	createImage,
	createPage,
} from "../ir/builders.js";
import { validateCanvasIRInvariants } from "../ir/invariants.js";
import type { CanvasImageNode, CanvasIR } from "../ir/types.js";
import { CanvasImageNodeSchema, CanvasIRSchema } from "../ir/validators.js";
import { serializePageToSvg } from "../serialize/svg.js";

/**
 * `CanvasImageNode.maskAssetId` is DEPRECATED, not removed — ADR 0008
 * (`docs/adr/0008-canvas-masking.md`) decision 3, executed by PLAN-0035
 * `cp4-007`. Removal is scheduled for `@anvilkit/canvas-core@1.0.0`.
 *
 * Deprecation in this package is a documentation state, never a behaviour
 * change, so this suite pins the behaviour that must NOT move during the
 * deprecation window. Each `it` maps to one of the six live consumers ADR 0008
 * enumerates plus the export refusal:
 *
 * 1. `ir/types.ts` — the declaration (a `@deprecated` TSDoc tag is compile-time
 *    only and cannot be asserted at runtime; the api-snapshot gate is what pins
 *    it, and `dist/ir/types.d.ts` is what carries it to consumers).
 * 2. `ir/builders.ts` — the public write path still writes the field through.
 * 3. `ir/validators.ts` — the schema still declares it, `min(1)` included, and
 *    a document carrying it still parses and round-trips.
 * 4. `ir/invariants.ts` — the reference-preservation invariant still reads it,
 *    so the mask asset is never reported dangling and never looks collectable.
 * 5. `clipboard/payload.ts` — a cross-document paste still re-keys the ref.
 * 6. `canvas-editor/src/actions/clipboard-actions.ts` — collection lives in the
 *    editor package and is covered by that package's own suite.
 *
 * Plus: `serialize/svg.ts` still refuses the field with
 * `IMAGE_MASK_UNSUPPORTED`, and its message now names the supported
 * replacement (a clipping frame) instead of implying the field is coming.
 */

const MASK_IMAGE_ID = "img-masked";
const SOURCE_ASSET = "asset-source";
const MASK_ASSET = "asset-mask";

const PIXEL_PNG =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function maskedImage(): CanvasImageNode {
	return createImage({
		id: MASK_IMAGE_ID,
		bounds: { width: 120, height: 80 },
		assetId: SOURCE_ASSET,
		maskAssetId: MASK_ASSET,
	});
}

/** A whole document carrying the deprecated field, with both assets present. */
function maskedDocument(id = "doc-mask"): CanvasIR {
	const ir = createCanvasIR({
		id,
		pages: [
			createPage({
				id: "p1",
				root: createGroup({
					id: "root",
					bounds: { width: 400, height: 300 },
					children: [maskedImage()],
				}),
			}),
		],
		now: () => "2026-08-07T00:00:00.000Z",
	});
	ir.assets = {
		[SOURCE_ASSET]: { id: SOURCE_ASSET, uri: PIXEL_PNG, mimeType: "image/png" },
		[MASK_ASSET]: { id: MASK_ASSET, uri: PIXEL_PNG, mimeType: "image/png" },
	};
	return ir;
}

function imageOf(ir: CanvasIR): CanvasImageNode {
	const node = ir.pages[0].root.children[0];
	expect(node.type).toBe("image");
	return node as CanvasImageNode;
}

describe("deprecated CanvasImageNode.maskAssetId — parse and round-trip", () => {
	it("the builder still writes the field through (consumer 2)", () => {
		expect(maskedImage().maskAssetId).toBe(MASK_ASSET);
	});

	it("a document carrying it survives parse -> serialize -> parse unchanged (consumer 3)", () => {
		const original = maskedDocument();

		// parse
		const parsedOnce = CanvasIRSchema.parse(original);
		expect(imageOf(parsedOnce).maskAssetId).toBe(MASK_ASSET);

		// serialize (document serialization is JSON — the untrusted wire form)
		const wire = JSON.stringify(parsedOnce);
		expect(wire).toContain(MASK_ASSET);

		// parse again
		const parsedTwice = CanvasIRSchema.parse(JSON.parse(wire));
		expect(imageOf(parsedTwice).maskAssetId).toBe(MASK_ASSET);

		// Nothing about the document moved across the round trip.
		expect(parsedTwice).toEqual(parsedOnce);
	});

	it("keeps the field a TYPED field, not a preserved unknown key — `min(1)` still rejects an empty string (consumer 3)", () => {
		// The `looseObject` posture would preserve `maskAssetId` even if the
		// declaration were dropped, so this is the assertion that proves the
		// declaration is still there: an unknown key carries no constraint.
		const empty = { ...maskedImage(), maskAssetId: "" };
		expect(CanvasImageNodeSchema.safeParse(empty).success).toBe(false);

		const valid = CanvasImageNodeSchema.safeParse(maskedImage());
		expect(valid.success).toBe(true);
	});

	it("still counts as an asset reference, so the mask asset is never reported dangling (consumer 4)", () => {
		const ok = validateCanvasIRInvariants(maskedDocument());
		expect(ok.filter((i) => i.code === "dangling-asset-reference")).toEqual([]);

		// Remove the mask asset and the invariant MUST notice — that is what
		// proves the reference is really being read rather than merely tolerated.
		const orphaned = maskedDocument();
		delete orphaned.assets[MASK_ASSET];
		const issues = validateCanvasIRInvariants(orphaned).filter(
			(i) => i.code === "dangling-asset-reference",
		);
		expect(issues).toHaveLength(1);
		expect(issues[0].message).toContain(MASK_ASSET);
	});

	it("survives a cross-document paste with its reference re-keyed (consumer 5)", () => {
		// The target already owns `asset-mask`, but a DIFFERENT one, so the
		// pasted payload's asset must be re-keyed and every reference rewritten.
		const target = createCanvasIR({
			id: "target-doc",
			pages: [createPage({ id: "tp1" })],
			now: () => "2026-08-07T00:00:00.000Z",
		});
		target.assets = {
			[MASK_ASSET]: {
				id: MASK_ASSET,
				uri: "https://example.test/other.png",
				mimeType: "image/png",
			},
		};

		const payload: CanvasClipboardPayload = {
			version: CANVAS_CLIPBOARD_VERSION,
			sourceDocumentId: "doc-mask",
			nodes: [maskedImage()],
			assetRefs: {
				[SOURCE_ASSET]: {
					id: SOURCE_ASSET,
					uri: PIXEL_PNG,
					mimeType: "image/png",
				},
				[MASK_ASSET]: { id: MASK_ASSET, uri: PIXEL_PNG, mimeType: "image/png" },
			},
			bounds: { x: 0, y: 0, width: 120, height: 80 },
		};

		let seq = 0;
		const { nodes, assetsToAdd } = materializeClipboardNodes(payload, target, {
			idFactory: () => `new-${++seq}`,
		});

		const pasted = nodes[0] as CanvasImageNode;
		expect(pasted.maskAssetId).toBeDefined();
		expect(pasted.maskAssetId).not.toBe(MASK_ASSET);
		expect(assetsToAdd[pasted.maskAssetId as string]).toBeDefined();
		expect(assetsToAdd[pasted.maskAssetId as string].uri).toBe(PIXEL_PNG);
	});
});

describe("deprecated CanvasImageNode.maskAssetId — SVG export tells the truth", () => {
	it("still warns IMAGE_MASK_UNSUPPORTED and still emits the image", async () => {
		const { svg, warnings } = await serializePageToSvg(maskedDocument(), 0);
		expect(warnings.map((w) => w.code)).toContain("IMAGE_MASK_UNSUPPORTED");
		// The node is never flattened or dropped to hide the gap.
		expect(svg).toContain("<image");
	});

	it("names the clipping-frame replacement and promises no future support", async () => {
		const { warnings } = await serializePageToSvg(maskedDocument(), 0);
		const mask = warnings.find((w) => w.code === "IMAGE_MASK_UNSUPPORTED");
		expect(mask).toBeDefined();
		expect(mask?.message).toContain("clipping frame");
		expect(mask?.message).toContain("@anvilkit/canvas-core@1.0.0");
		expect(mask?.message).toContain("will not be");
		// A warning that implies support is coming is the exact defect cp4-007
		// closes — the previous message's rationale said a future vector-mask
		// implementation would land here. It lands on the frame instead.
		expect(mask?.message).not.toMatch(/future|planned|not yet|coming/i);
	});

	it("the deprecated field never survives into the emitted SVG", async () => {
		const { svg } = await serializePageToSvg(maskedDocument(), 0);
		expect(svg).not.toContain("maskAssetId");
		expect(svg).not.toContain("<mask");
	});
});
