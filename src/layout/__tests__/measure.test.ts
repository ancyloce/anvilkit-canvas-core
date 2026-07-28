import { describe, expect, it, vi } from "vitest";
import {
	createImage,
	createRect,
	createRichText,
	createText,
} from "../../ir/builders.js";
import type { CanvasAssetRef, CanvasNode } from "../../ir/types.js";
import {
	MAX_MEASUREMENT_REQUESTS,
	MAX_MEASUREMENT_TEXT_LENGTH,
} from "../../limits.js";
import type { MeasuredText, TextMeasureRequest } from "../../text-contracts.js";
import {
	createMeasurementContext,
	measureIntrinsicSize,
	measurementKey,
} from "../measure.js";

const box = { width: 80, height: 20 };

/** A measurer whose output is a deterministic function of its input. */
function stubMeasurer(
	onCall?: (request: TextMeasureRequest) => void,
): (request: TextMeasureRequest) => MeasuredText {
	return (request) => {
		onCall?.(request);
		let chars = 0;
		for (const paragraph of request.paragraphs) {
			for (const span of paragraph.spans) chars += span.text.length;
		}
		return {
			lines: [],
			width: chars * 10,
			height: 24 * request.paragraphs.length,
		};
	};
}

describe("measureIntrinsicSize — text (T-M2-03)", () => {
	it("adapts a plain `text` node to one span, one paragraph, wrap:none", () => {
		const requests: TextMeasureRequest[] = [];
		const context = createMeasurementContext(
			{},
			{ provider: { measureText: stubMeasurer((r) => requests.push(r)) } },
		);
		const node = createText({
			id: "t1",
			text: "hello",
			bounds: box,
		}) as CanvasNode;

		const result = measureIntrinsicSize(node, context);

		expect(requests).toHaveLength(1);
		const request = requests[0] as TextMeasureRequest;
		expect(request.paragraphs).toHaveLength(1);
		expect(request.paragraphs[0]?.spans).toHaveLength(1);
		expect(request.paragraphs[0]?.spans[0]?.text).toBe("hello");
		// TS-10: a single-line node measures with wrap disabled — that is what
		// "single line" means to the measurer.
		expect(request.wrap).toBe("none");
		expect(result.size).toEqual({ width: 50, height: 24 });
		expect(result.issue).toBeUndefined();
	});

	it("carries the text node's own font fields into the span so they beat host defaults", () => {
		const requests: TextMeasureRequest[] = [];
		const context = createMeasurementContext(
			{},
			{ provider: { measureText: stubMeasurer((r) => requests.push(r)) } },
		);
		const node = {
			...createText({ id: "t1", text: "hi", bounds: box }),
			fontFamily: "Georgia",
			fontSize: 41,
			fontWeight: "700",
		} as CanvasNode;

		measureIntrinsicSize(node, context);

		const span = requests[0]?.paragraphs[0]?.spans[0];
		expect(span?.fontFamily).toBe("Georgia");
		expect(span?.fontSize).toBe(41);
		expect(span?.fontWeight).toBe("700");
	});

	it("measures rich text against its authored wrap width", () => {
		const requests: TextMeasureRequest[] = [];
		const context = createMeasurementContext(
			{},
			{ provider: { measureText: stubMeasurer((r) => requests.push(r)) } },
		);
		const node = createRichText({
			id: "r1",
			width: 240,
			paragraphs: [{ spans: [{ text: "abcd" }] }],
			bounds: box,
		}) as CanvasNode;

		const result = measureIntrinsicSize(node, context);

		expect(requests[0]?.width).toBe(240);
		expect(requests[0]?.wrap).toBe("word");
		expect(result.size).toEqual({ width: 40, height: 24 });
	});

	it("measures an auto-width rich-text node unconstrained", () => {
		const requests: TextMeasureRequest[] = [];
		const context = createMeasurementContext(
			{},
			{ provider: { measureText: stubMeasurer((r) => requests.push(r)) } },
		);
		const node = {
			...createRichText({
				id: "r1",
				width: 240,
				paragraphs: [{ spans: [{ text: "abcd" }] }],
				bounds: box,
			}),
			sizing: "auto-width",
		} as CanvasNode;

		measureIntrinsicSize(node, context);

		// Unconstrained means "report the natural width", not "wrap at 0".
		expect(requests[0]?.width).toBe(Number.POSITIVE_INFINITY);
	});

	it("prefers a caller-supplied width constraint over the authored one", () => {
		const requests: TextMeasureRequest[] = [];
		const context = createMeasurementContext(
			{},
			{ provider: { measureText: stubMeasurer((r) => requests.push(r)) } },
		);
		const node = createRichText({
			id: "r1",
			width: 240,
			paragraphs: [{ spans: [{ text: "abcd" }] }],
			bounds: box,
		}) as CanvasNode;

		measureIntrinsicSize(node, context, 99);

		expect(requests[0]?.width).toBe(99);
	});
});

describe("measureIntrinsicSize — assets (T-M2-03)", () => {
	const assets: Record<string, CanvasAssetRef> = {
		a1: { id: "a1", uri: "x", width: 640, height: 480 },
		noSize: { id: "noSize", uri: "y" },
	};

	it("reads the document's asset record first", () => {
		const getIntrinsicAssetSize = vi.fn(() => ({ width: 1, height: 1 }));
		const context = createMeasurementContext(assets, {
			provider: { measureText: stubMeasurer(), getIntrinsicAssetSize },
		});
		const node = createImage({
			id: "i1",
			assetId: "a1",
			bounds: box,
		}) as CanvasNode;

		expect(measureIntrinsicSize(node, context).size).toEqual({
			width: 640,
			height: 480,
		});
		// The document is what an export worker also has; consulting a
		// session-local provider first would let one document resolve two ways.
		expect(getIntrinsicAssetSize).not.toHaveBeenCalled();
	});

	it("falls back to the provider when the document records no size", () => {
		const context = createMeasurementContext(assets, {
			provider: {
				measureText: stubMeasurer(),
				getIntrinsicAssetSize: () => ({ width: 12, height: 34 }),
			},
		});
		const node = createImage({
			id: "i1",
			assetId: "noSize",
			bounds: box,
		}) as CanvasNode;

		expect(measureIntrinsicSize(node, context).size).toEqual({
			width: 12,
			height: 34,
		});
	});

	it("diagnoses an unmeasurable asset instead of throwing", () => {
		const context = createMeasurementContext(assets, {
			provider: { measureText: stubMeasurer() },
		});
		const node = createImage({
			id: "i1",
			assetId: "noSize",
			bounds: box,
		}) as CanvasNode;

		const result = measureIntrinsicSize(node, context);

		expect(result.size).toEqual(box);
		expect(result.issue?.code).toBe("layout-measurement-missing");
		expect(result.issue?.nodeId).toBe("i1");
	});
});

describe("measureIntrinsicSize — failure is never a throw (NFR-REL-002)", () => {
	const node = () =>
		createText({ id: "t1", text: "hello", bounds: box }) as CanvasNode;

	it("diagnoses a missing provider", () => {
		const result = measureIntrinsicSize(node(), createMeasurementContext({}));
		expect(result.size).toEqual(box);
		expect(result.issue?.code).toBe("layout-measurement-missing");
		expect(result.issue?.severity).toBe("warning");
	});

	it("diagnoses a measurer that throws", () => {
		const context = createMeasurementContext(
			{},
			{
				provider: {
					measureText: () => {
						throw new Error("font not loaded");
					},
				},
			},
		);
		const result = measureIntrinsicSize(node(), context);
		expect(result.size).toEqual(box);
		expect(result.issue?.message).toContain("font not loaded");
	});

	it("diagnoses a measurer returning a non-finite size", () => {
		const context = createMeasurementContext(
			{},
			{
				provider: {
					measureText: () => ({
						lines: [],
						width: Number.NaN,
						height: 10,
					}),
				},
			},
		);
		const result = measureIntrinsicSize(node(), context);
		expect(result.size).toEqual(box);
		expect(result.issue?.code).toBe("layout-measurement-missing");
	});

	it("stops measuring past MAX_MEASUREMENT_REQUESTS", () => {
		const context = createMeasurementContext(
			{},
			{ provider: { measureText: stubMeasurer() } },
		);
		context.budget.spent = MAX_MEASUREMENT_REQUESTS;
		const result = measureIntrinsicSize(node(), context);
		expect(result.issue?.message).toContain("MAX_MEASUREMENT_REQUESTS");
	});

	it("refuses a single pathological string past MAX_MEASUREMENT_TEXT_LENGTH", () => {
		const context = createMeasurementContext(
			{},
			{ provider: { measureText: stubMeasurer() } },
		);
		const huge = {
			...createText({ id: "t1", text: "x", bounds: box }),
			text: "x".repeat(MAX_MEASUREMENT_TEXT_LENGTH + 1),
		} as CanvasNode;
		const result = measureIntrinsicSize(huge, context);
		expect(result.issue?.message).toContain("MAX_MEASUREMENT_TEXT_LENGTH");
	});

	it("returns stored bounds for a leaf with no intrinsic size, silently", () => {
		// Requesting Hug on a rect is `layout-hug-unsupported`'s job to report;
		// this function's contract is to always return a usable size.
		const result = measureIntrinsicSize(
			createRect({ id: "r1", bounds: box }) as CanvasNode,
			createMeasurementContext({}),
		);
		expect(result.size).toEqual(box);
		expect(result.issue).toBeUndefined();
	});
});

describe("measurementKey (TD §8.2)", () => {
	const base = {
		kind: "rich-text" as const,
		paragraphs: [{ spans: [{ text: "abc" }] }],
		wrap: "word" as const,
		width: 100,
		defaults: createMeasurementContext({}).defaults,
		manifestHash: "m1",
	};

	it("is stable for identical inputs", () => {
		expect(measurementKey(base)).toBe(measurementKey(base));
	});

	it("separates two nodes that differ only in host defaults", () => {
		// The bug in the editor's existing cache, made a test: it keys on the
		// paragraphs reference plus `${width}|${wrap}` and drops `defaults`, so
		// two nodes inheriting different defaults collide and the second renders
		// with the first's metrics.
		const other = {
			...base,
			defaults: { ...base.defaults, fontSize: 32 },
		};
		expect(measurementKey(other)).not.toBe(measurementKey(base));
	});

	it("separates differing line height and alignment", () => {
		expect(
			measurementKey({
				...base,
				paragraphs: [{ lineHeight: 2, spans: [{ text: "abc" }] }],
			}),
		).not.toBe(measurementKey(base));
		expect(
			measurementKey({
				...base,
				paragraphs: [{ align: "right", spans: [{ text: "abc" }] }],
			}),
		).not.toBe(measurementKey(base));
	});

	it("separates differing wrap, width, kind and manifest", () => {
		expect(measurementKey({ ...base, wrap: "none" })).not.toBe(
			measurementKey(base),
		);
		expect(measurementKey({ ...base, width: 101 })).not.toBe(
			measurementKey(base),
		);
		expect(measurementKey({ ...base, width: undefined })).not.toBe(
			measurementKey(base),
		);
		expect(measurementKey({ ...base, kind: "text" })).not.toBe(
			measurementKey(base),
		);
		expect(measurementKey({ ...base, manifestHash: "m2" })).not.toBe(
			measurementKey(base),
		);
	});

	it("shares one entry across nodes with identical content and style", () => {
		// This is what makes the §15.1 "100 text nodes over 20 measurement keys"
		// workload cost 20 measurements rather than 100 — no node id in the key.
		let calls = 0;
		const context = createMeasurementContext(
			{},
			{ provider: { measureText: stubMeasurer(() => calls++) } },
		);
		for (let i = 0; i < 5; i++) {
			measureIntrinsicSize(
				createText({ id: `t${i}`, text: "same", bounds: box }) as CanvasNode,
				context,
			);
		}
		expect(calls).toBe(1);
		expect(context.budget.spent).toBe(1);
	});
});
