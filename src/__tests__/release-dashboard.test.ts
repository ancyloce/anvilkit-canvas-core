import { describe, expect, it } from "vitest";
import {
	buildCanvasReleaseDashboard,
	CANVAS_RELEASE_ALERT_THRESHOLDS,
} from "../release-dashboard.js";
import {
	type CanvasTelemetryEvent,
	type CanvasTelemetryEventKey,
	type CanvasTelemetryPayloads,
	canvasTelemetryEvent,
} from "../telemetry.js";

const CONTEXT = {
	release: "0.1.2-rc.1",
	occurredAt: "2026-08-27T00:00:00.000Z",
} as const;

function events<K extends CanvasTelemetryEventKey>(
	count: number,
	key: K,
	properties: CanvasTelemetryPayloads[K],
): CanvasTelemetryEvent[] {
	return Array.from({ length: count }, () =>
		canvasTelemetryEvent(key, properties, CONTEXT),
	);
}

function metric(
	dashboard: ReturnType<typeof buildCanvasReleaseDashboard>,
	id: (typeof CANVAS_RELEASE_ALERT_THRESHOLDS)[number]["metricId"],
) {
	const found = dashboard.metrics.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`missing ${id}`);
	return found;
}

describe("Canvas release dashboard (E0-T4)", () => {
	it("exposes every required release metric even before data arrives", () => {
		const dashboard = buildCanvasReleaseDashboard([], {
			generatedAt: CONTEXT.occurredAt,
		});
		expect(dashboard.metrics.map(({ id }) => id)).toEqual(
			CANVAS_RELEASE_ALERT_THRESHOLDS.map(({ metricId }) => metricId),
		);
		expect(
			dashboard.metrics.every(({ status }) => status === "insufficient-data"),
		).toBe(true);
		expect(dashboard.alerts).toEqual([]);
	});

	it("calculates success, reconnect, AI, cancellation, rejection, and crash rates", () => {
		const sample: CanvasTelemetryEvent[] = [
			...events(20, "load", {
				outcome: "succeeded",
				origin: "persistence",
				durationMs: 5,
				nodeCountBucket: "100-999",
			}),
			...events(20, "save", {
				outcome: "succeeded",
				trigger: "auto",
				durationMs: 8,
			}),
			...events(19, "export", {
				format: "png",
				outcome: "succeeded",
				durationMs: 20,
				pageCount: 1,
			}),
			...events(1, "export", {
				format: "png",
				outcome: "failed",
				durationMs: 20,
				pageCount: 1,
				errorClass: "resource-rejection",
			}),
			...events(20, "collaboration", {
				operation: "reconnect",
				outcome: "succeeded",
				durationMs: 50,
				attempt: 1,
			}),
			...events(18, "aiJob", {
				capability: "image",
				outcome: "succeeded",
				durationMs: 500,
				providerKind: "mock",
			}),
			...events(2, "aiJob", {
				capability: "image",
				outcome: "cancelled",
				durationMs: 50,
				providerKind: "mock",
			}),
			...events(20, "performance", {
				interaction: "drag",
				phase: "input-to-preview",
				durationMs: 25,
				nodeCountBucket: "1000-4999",
			}),
			...events(1, "error", {
				boundary: "render",
				classification: "rendering",
				code: "CANVAS_RENDER_CRASH",
				recoverable: false,
				fatal: true,
			}),
		];
		const dashboard = buildCanvasReleaseDashboard(sample, {
			generatedAt: CONTEXT.occurredAt,
		});
		expect(metric(dashboard, "load-success-rate").value).toBe(1);
		expect(metric(dashboard, "save-success-rate").value).toBe(1);
		expect(metric(dashboard, "export-success-rate").value).toBe(0.95);
		expect(metric(dashboard, "collaboration-reconnect-rate").value).toBe(1);
		expect(metric(dashboard, "ai-job-success-rate").value).toBe(1);
		expect(metric(dashboard, "cancellation-rate").value).toBe(0.05);
		expect(metric(dashboard, "interaction-latency-p95-ms").value).toBe(25);
		expect(metric(dashboard, "resource-rejection-rate").numerator).toBe(1);
		expect(metric(dashboard, "crash-rate").numerator).toBe(1);
		expect(dashboard.alerts.map(({ metricId }) => metricId)).toContain(
			"interaction-latency-p95-ms",
		);
	});

	it("raises a critical convergence alert on the first failed check", () => {
		const dashboard = buildCanvasReleaseDashboard(
			events(1, "collaboration", {
				operation: "convergence-check",
				outcome: "failed",
				durationMs: 10,
				attempt: 1,
				errorClass: "collaboration-convergence",
			}),
		);
		expect(
			metric(dashboard, "collaboration-convergence-failures"),
		).toMatchObject({
			value: 1,
			status: "critical",
		});
		expect(dashboard.alerts).toContainEqual({
			metricId: "collaboration-convergence-failures",
			owner: "collaboration",
			severity: "critical",
			value: 1,
		});
	});
});
