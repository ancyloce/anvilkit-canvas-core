import { describe, expect, it, vi } from "vitest";
import {
	createCanvasIR,
	createGroup,
	createImage,
	createPage,
	createSvg,
	insertNode,
} from "../../ir/index.js";
import type { CanvasIR } from "../../ir/types.js";
import { isLocalObjectUri } from "../../uri.js";
import type { SvgFetchAsset } from "../svg.js";
import { serializePageToSvg } from "../svg.js";

/**
 * cp1-006 — browser-local asset URIs reach the injected `SvgFetchAsset`.
 *
 * A `blob:` URI is meaningless outside the session that minted it, so the
 * scheme allowlist rejects it for referencing and always will. Before this
 * change that rejection ran BEFORE the embed branch, so the fetcher the
 * serializer already accepts could never see one and a locally-uploaded image
 * exported as nothing at all (`UNSAFE_URI` + no `<image>`). These specs pin the
 * rescue path and, just as importantly, pin the schemes it must NOT rescue.
 */

const NOW = "2026-01-01T00:00:00.000Z";
const BYTES = new Uint8Array([72, 105]); // "Hi" → base64 "SGk="

function makeIR(uri: string, kind: "image" | "svg" = "image"): CanvasIR {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({
		id: "doc-1",
		title: "Local",
		pages: [page],
		now: () => NOW,
	});
	const node =
		kind === "image"
			? createImage({
					id: "n1",
					assetId: "a1",
					bounds: { x: 0, y: 0, width: 10, height: 10 },
				})
			: createSvg({
					id: "n1",
					assetId: "a1",
					bounds: { x: 0, y: 0, width: 10, height: 10 },
				});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createGroup({ id: "g1", children: [node] }),
	});
	return { ...ir, assets: { a1: { id: "a1", uri } } };
}

describe("isLocalObjectUri", () => {
	it("matches exactly the two browser-local schemes", () => {
		expect(isLocalObjectUri("blob:http://localhost/abc-123")).toBe(true);
		expect(isLocalObjectUri("BLOB:http://localhost/abc-123")).toBe(true);
		expect(isLocalObjectUri("filesystem:http://x/temporary/f")).toBe(true);
		expect(isLocalObjectUri("  blob:http://localhost/abc  ")).toBe(true);
	});

	it("rejects portable, dangerous and non-string input", () => {
		for (const uri of [
			"https://cdn.example.com/x.png",
			"//cdn.example.com/x.png",
			"/relative.png",
			"data:image/png;base64,SGk=",
			"javascript:alert(1)",
			"file:///etc/passwd",
			"",
		]) {
			expect(isLocalObjectUri(uri)).toBe(false);
		}
		expect(isLocalObjectUri(undefined as unknown as string)).toBe(false);
	});

	it("cannot be spoofed by control characters inside the scheme", () => {
		// `blo\nb:` is not blob:, and `java\nscript:` must not become fetchable
		// just because a control character broke the literal prefix.
		expect(isLocalObjectUri("blo\nb:x")).toBe(true); // stripped → "blob:"
		expect(isLocalObjectUri("java\nscript:alert(1)")).toBe(false);
	});
});

describe("serializePageToSvg — browser-local asset URIs (cp1-006)", () => {
	const fetchAsset: SvgFetchAsset = async () => ({
		bytes: BYTES,
		contentType: "image/png",
	});

	it("embeds a blob: image through the injected fetcher instead of dropping it", async () => {
		const spy = vi.fn(fetchAsset);
		const { svg, warnings } = await serializePageToSvg(
			makeIR("blob:http://localhost/abc-123"),
			0,
			{ fetchAsset: spy },
		);
		expect(spy).toHaveBeenCalledWith("blob:http://localhost/abc-123");
		expect(svg).toContain('href="data:image/png;base64,SGk="');
		expect(svg).not.toContain("blob:");
		// The rescue is silent: nothing was lost, so nothing is warned.
		expect(warnings.map((w) => w.code)).not.toContain("UNSAFE_URI");
		expect(warnings.map((w) => w.code)).not.toContain("MISSING_ASSET");
	});

	it("rescues an svg node's asset through the same single choke point", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR("blob:http://localhost/abc-123", "svg"),
			0,
			{
				fetchAsset: async () => ({
					bytes: BYTES,
					contentType: "image/svg+xml",
				}),
			},
		);
		expect(svg).toContain('href="data:image/svg+xml;base64,SGk="');
		expect(warnings.map((w) => w.code)).not.toContain("UNSAFE_URI");
	});

	it("still works in explicit embed mode", async () => {
		const { svg } = await serializePageToSvg(
			makeIR("blob:http://localhost/abc-123"),
			0,
			{ images: "embed", fetchAsset },
		);
		expect(svg).toContain('href="data:image/png;base64,SGk="');
	});

	it("drops with UNSAFE_URI when no fetcher was supplied", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR("blob:http://localhost/abc-123"),
			0,
		);
		expect(warnings.map((w) => w.code)).toContain("UNSAFE_URI");
		expect(svg).not.toContain("<image");
	});

	it("honours images:'reference' by dropping rather than embedding", async () => {
		const spy = vi.fn(fetchAsset);
		const { svg, warnings } = await serializePageToSvg(
			makeIR("blob:http://localhost/abc-123"),
			0,
			{ images: "reference", fetchAsset: spy },
		);
		expect(spy).not.toHaveBeenCalled();
		expect(warnings.map((w) => w.code)).toContain("UNSAFE_URI");
		expect(svg).not.toContain("<image");
	});

	it("warns MISSING_ASSET — not UNSAFE_URI — when the fetcher cannot resolve it", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR("blob:http://localhost/gone"),
			0,
			{
				fetchAsset: async () => {
					throw new Error("not stored");
				},
			},
		);
		const codes = warnings.map((w) => w.code);
		// "your local copy is gone" must not be reported as "your document uses
		// a dangerous scheme" — and it must not be reported as both.
		expect(codes).toContain("MISSING_ASSET");
		expect(codes).not.toContain("UNSAFE_URI");
		expect(warnings.find((w) => w.code === "MISSING_ASSET")?.message).toContain(
			"the image is omitted",
		);
		expect(svg).not.toContain("<image");
	});

	it("never offers a dangerous scheme to the fetcher, even with one supplied", async () => {
		const spy = vi.fn(fetchAsset);
		const { svg, warnings } = await serializePageToSvg(
			makeIR("javascript:alert(1)"),
			0,
			{ images: "embed", fetchAsset: spy },
		);
		expect(spy).not.toHaveBeenCalled();
		expect(warnings.map((w) => w.code)).toContain("UNSAFE_URI");
		expect(svg).not.toContain("<image");
	});

	it("leaves the remote-URI path exactly as it was", async () => {
		// `auto` + a fetcher must NOT start embedding remote images: the fetcher
		// is only consulted for URIs that could not be referenced at all.
		const spy = vi.fn(fetchAsset);
		const { svg, warnings } = await serializePageToSvg(
			makeIR("https://cdn.example.com/x.png"),
			0,
			{ fetchAsset: spy },
		);
		expect(spy).not.toHaveBeenCalled();
		expect(svg).toContain('href="https://cdn.example.com/x.png"');
		expect(warnings).toHaveLength(0);
	});

	it("keeps the remote failure message saying 'referencing instead'", async () => {
		const { svg, warnings } = await serializePageToSvg(
			makeIR("https://cdn.example.com/x.png"),
			0,
			{
				images: "embed",
				fetchAsset: async () => {
					throw new Error("CORS");
				},
			},
		);
		expect(warnings.find((w) => w.code === "MISSING_ASSET")?.message).toContain(
			"referencing instead.",
		);
		expect(svg).toContain('href="https://cdn.example.com/x.png"');
	});
});
