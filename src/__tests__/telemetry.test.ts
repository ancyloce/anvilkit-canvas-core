import { describe, expect, it, vi } from "vitest";
import {
	CANVAS_TELEMETRY_EVENTS,
	canvasTelemetryEvent,
	emitCanvasTelemetry,
	inspectCanvasTelemetrySafety,
} from "../telemetry.js";

const CONTEXT = {
	release: "0.1.2-rc.1",
	environmentId: "canvas-desktop-primary-v1",
	occurredAt: "2026-08-27T00:00:00.000Z",
} as const;

describe("Canvas telemetry contracts (E0-T3)", () => {
	it("covers every required operational domain", () => {
		expect(Object.keys(CANVAS_TELEMETRY_EVENTS)).toEqual([
			"load",
			"save",
			"recovery",
			"export",
			"collaboration",
			"aiJob",
			"performance",
			"error",
		]);
	});

	it("constructs and emits a content-free event", () => {
		const event = canvasTelemetryEvent(
			"load",
			{
				outcome: "succeeded",
				origin: "persistence",
				durationMs: 42,
				nodeCountBucket: "100-999",
			},
			CONTEXT,
		);
		const sink = vi.fn();
		expect(inspectCanvasTelemetrySafety(event)).toEqual([]);
		expect(emitCanvasTelemetry(sink, event)).toBe("emitted");
		expect(sink).toHaveBeenCalledWith(event);
	});

	it.each([
		["raw document text", { text: "customer copy" }],
		["image binary data", { binary: "iVBORw0KGgo" }],
		["prompt", { prompt: "make this private image brighter" }],
		["token", { token: "provider-token" }],
		["personal identity", { email: "person@example.com" }],
		["asset URL", { value: "https://cdn.example.test/private.png" }],
	] as const)("drops %s before calling the sink", (_label, forbidden) => {
		const safe = canvasTelemetryEvent(
			"error",
			{
				boundary: "render",
				classification: "rendering",
				code: "CANVAS_RENDER_FAILED",
				recoverable: false,
				fatal: true,
			},
			CONTEXT,
		);
		const unsafe = {
			...safe,
			properties: { ...safe.properties, ...forbidden },
		};
		const sink = vi.fn();
		expect(inspectCanvasTelemetrySafety(unsafe).length).toBeGreaterThan(0);
		expect(emitCanvasTelemetry(sink, unsafe)).toBe("dropped-unsafe");
		expect(sink).not.toHaveBeenCalled();
	});

	it("contains only paths, never the rejected value, in safety diagnostics", () => {
		const secret = "private customer wording";
		const issues = inspectCanvasTelemetrySafety({ content: secret });
		expect(issues.join(" ")).toContain("event.content");
		expect(issues.join(" ")).not.toContain(secret);
	});

	it("does not make a user operation depend on a host sink", () => {
		const event = canvasTelemetryEvent(
			"save",
			{
				outcome: "succeeded",
				trigger: "manual",
				durationMs: 10,
			},
			CONTEXT,
		);
		expect(
			emitCanvasTelemetry(() => {
				throw new Error("host telemetry offline");
			}, event),
		).toBe("sink-failed");
		expect(emitCanvasTelemetry(undefined, event)).toBe("no-sink");
	});
});
