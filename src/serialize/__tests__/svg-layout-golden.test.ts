import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	contractFixture,
	contractMeasureText,
} from "../../layout/__tests__/contract/fixtures.js";
import { resolveCanvasLayout } from "../../layout/resolve.js";
import { serializePageToSvg } from "../index.js";

/**
 * @file T-M5-02 — committed SVG goldens for Auto Layout output. The
 * structural parity harness (`layout/__tests__/contract/`) asserts geometry
 * agreement; these snapshots pin the exact bytes so serializer drift fails
 * loudly, matching the `svg-golden.test.ts` convention. Browser screenshot
 * baselines are generated on CI hardware via the `editor-visual`
 * workflow_dispatch (A-4), never on this host.
 */

/**
 * Minimal well-formedness scan (mirrors `svg-golden.test.ts`'s
 * `assertWellFormed`, which is file-local there): every opened tag closes,
 * and no element repeats an attribute name.
 */
function assertWellFormed(svg: string): void {
	const stack: string[] = [];
	for (const match of svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
		const [, closing, tag, attrs, selfClosing] = match;
		if (closing) {
			expect(stack.pop(), `closing </${tag}>`).toBe(tag);
			continue;
		}
		const names = [...(attrs ?? "").matchAll(/([\w:-]+)=/g)].map((m) => m[1]);
		expect(new Set(names).size, `duplicate attribute in <${tag}>`).toBe(
			names.length,
		);
		if (!selfClosing) stack.push(tag ?? "");
	}
	expect(stack, "unclosed tags").toEqual([]);
}

function goldenPath(name: string): string {
	return fileURLToPath(new URL(`./__snapshots__/${name}`, import.meta.url));
}

async function serializeFixture(
	id: string,
	withResolution: boolean,
): Promise<{ svg: string; codes: string[] }> {
	const { ir, options } = contractFixture(id).build();
	const { svg, warnings } = await serializePageToSvg(ir, "p1", {
		pretty: true,
		textMeasurer: contractMeasureText,
		...(withResolution
			? { resolvedDocument: resolveCanvasLayout(ir, options) }
			: {}),
	});
	return { svg, codes: warnings.map((w) => w.code) };
}

describe("Auto Layout SVG goldens (T-M5-02, AC-009)", () => {
	it("pricing row with Fill child", async () => {
		const { svg, codes } = await serializeFixture("pricing-row-fill", true);
		expect(codes).toEqual([]);
		assertWellFormed(svg);
		await expect(svg).toMatchFileSnapshot(
			goldenPath("canvas-layout-pricing-row.snap.svg"),
		);
	});

	it("nested product card", async () => {
		const { svg, codes } = await serializeFixture("nested-product-card", true);
		expect(codes).toEqual([]);
		assertWellFormed(svg);
		await expect(svg).toMatchFileSnapshot(
			goldenPath("canvas-layout-nested-card.snap.svg"),
		);
	});

	it("absolute badge overlay", async () => {
		const { svg, codes } = await serializeFixture("absolute-badge", true);
		expect(codes).toEqual([]);
		assertWellFormed(svg);
		await expect(svg).toMatchFileSnapshot(
			goldenPath("canvas-layout-absolute-badge.snap.svg"),
		);
	});

	it("omitting the resolved document fires LAYOUT_UNRESOLVED and falls back to stored geometry", async () => {
		const { svg, codes } = await serializeFixture("pricing-row-fill", false);
		expect(codes).toContain("LAYOUT_UNRESOLVED");
		assertWellFormed(svg);
		await expect(svg).toMatchFileSnapshot(
			goldenPath("canvas-layout-unresolved-fallback.snap.svg"),
		);
	});
});
