import type { CanvasTelemetryEvent } from "./telemetry.js";

export type CanvasReleaseDashboardMetricId =
	| "ai-job-success-rate"
	| "cancellation-rate"
	| "collaboration-convergence-failures"
	| "collaboration-reconnect-rate"
	| "crash-rate"
	| "export-success-rate"
	| "interaction-latency-p95-ms"
	| "load-success-rate"
	| "resource-rejection-rate"
	| "save-success-rate"
	| "unrecoverable-error-rate";

export type CanvasReleaseDashboardOwner =
	| "ai"
	| "canvas-core"
	| "canvas-editor"
	| "collaboration";

export interface CanvasReleaseAlertThreshold {
	readonly metricId: CanvasReleaseDashboardMetricId;
	readonly owner: CanvasReleaseDashboardOwner;
	readonly direction: "at-least" | "at-most";
	readonly warning: number;
	readonly critical: number;
	readonly minimumSamples: number;
	readonly unit: "count" | "milliseconds" | "ratio";
	readonly description: string;
}

/** Proposed E0 alert policy. Threshold changes require release-owner review. */
export const CANVAS_RELEASE_ALERT_THRESHOLDS = [
	{
		metricId: "load-success-rate",
		owner: "canvas-core",
		direction: "at-least",
		warning: 0.999,
		critical: 0.99,
		minimumSamples: 20,
		unit: "ratio",
		description: "Valid document loads that reach a usable editor state.",
	},
	{
		metricId: "save-success-rate",
		owner: "canvas-editor",
		direction: "at-least",
		warning: 0.999,
		critical: 0.99,
		minimumSamples: 20,
		unit: "ratio",
		description: "Save attempts that complete successfully.",
	},
	{
		metricId: "export-success-rate",
		owner: "canvas-editor",
		direction: "at-least",
		warning: 0.995,
		critical: 0.98,
		minimumSamples: 20,
		unit: "ratio",
		description: "Non-cancelled export jobs that complete successfully.",
	},
	{
		metricId: "unrecoverable-error-rate",
		owner: "canvas-core",
		direction: "at-most",
		warning: 0.002,
		critical: 0.01,
		minimumSamples: 100,
		unit: "ratio",
		description: "Unrecoverable classified errors per operational event.",
	},
	{
		metricId: "interaction-latency-p95-ms",
		owner: "canvas-editor",
		direction: "at-most",
		warning: 16.7,
		critical: 50,
		minimumSamples: 20,
		unit: "milliseconds",
		description: "p95 input-to-preview latency for direct manipulation.",
	},
	{
		metricId: "collaboration-reconnect-rate",
		owner: "collaboration",
		direction: "at-least",
		warning: 0.995,
		critical: 0.95,
		minimumSamples: 20,
		unit: "ratio",
		description: "Reconnect attempts that restore synchronization.",
	},
	{
		metricId: "ai-job-success-rate",
		owner: "ai",
		direction: "at-least",
		warning: 0.95,
		critical: 0.8,
		minimumSamples: 20,
		unit: "ratio",
		description: "Non-cancelled terminal AI jobs that succeed.",
	},
	{
		metricId: "cancellation-rate",
		owner: "canvas-editor",
		direction: "at-most",
		warning: 0.2,
		critical: 0.35,
		minimumSamples: 20,
		unit: "ratio",
		description: "Cancel-capable export and AI jobs cancelled by the user.",
	},
	{
		metricId: "crash-rate",
		owner: "canvas-editor",
		direction: "at-most",
		warning: 0.002,
		critical: 0.01,
		minimumSamples: 100,
		unit: "ratio",
		description: "Fatal classified errors per operational event.",
	},
	{
		metricId: "resource-rejection-rate",
		owner: "canvas-core",
		direction: "at-most",
		warning: 0.05,
		critical: 0.1,
		minimumSamples: 20,
		unit: "ratio",
		description: "Budget or resource rejections per operational event.",
	},
	{
		metricId: "collaboration-convergence-failures",
		owner: "collaboration",
		direction: "at-most",
		warning: 0,
		critical: 0,
		minimumSamples: 1,
		unit: "count",
		description: "Failed collaboration convergence checks; zero is required.",
	},
] as const satisfies readonly CanvasReleaseAlertThreshold[];

export type CanvasReleaseMetricStatus =
	| "critical"
	| "insufficient-data"
	| "ok"
	| "warning";

export interface CanvasReleaseDashboardMetric {
	readonly id: CanvasReleaseDashboardMetricId;
	readonly value: number | null;
	readonly numerator: number;
	readonly denominator: number;
	readonly status: CanvasReleaseMetricStatus;
	readonly threshold: CanvasReleaseAlertThreshold;
}

export interface CanvasReleaseDashboardAlert {
	readonly metricId: CanvasReleaseDashboardMetricId;
	readonly owner: CanvasReleaseDashboardOwner;
	readonly severity: "critical" | "warning";
	readonly value: number;
}

export interface CanvasReleaseDashboard {
	readonly generatedAt: string;
	readonly eventCount: number;
	readonly metrics: readonly CanvasReleaseDashboardMetric[];
	readonly alerts: readonly CanvasReleaseDashboardAlert[];
}

function payload(
	event: CanvasTelemetryEvent,
): Readonly<Record<string, unknown>> {
	return event.properties as unknown as Readonly<Record<string, unknown>>;
}

function outcomeOf(event: CanvasTelemetryEvent): string | undefined {
	const outcome = payload(event).outcome;
	return typeof outcome === "string" ? outcome : undefined;
}

function errorClassOf(event: CanvasTelemetryEvent): string | undefined {
	const properties = payload(event);
	const errorClass = properties.errorClass ?? properties.classification;
	return typeof errorClass === "string" ? errorClass : undefined;
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

function p95(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null;
}

function statusOf(
	value: number | null,
	denominator: number,
	threshold: CanvasReleaseAlertThreshold,
): CanvasReleaseMetricStatus {
	if (value === null || denominator < threshold.minimumSamples) {
		return "insufficient-data";
	}
	if (threshold.direction === "at-least") {
		if (value < threshold.critical) return "critical";
		if (value < threshold.warning) return "warning";
		return "ok";
	}
	if (value > threshold.critical) return "critical";
	if (value > threshold.warning) return "warning";
	return "ok";
}

interface MetricInput {
	readonly id: CanvasReleaseDashboardMetricId;
	readonly value: number | null;
	readonly numerator: number;
	readonly denominator: number;
}

function buildMetric(input: MetricInput): CanvasReleaseDashboardMetric {
	const threshold = CANVAS_RELEASE_ALERT_THRESHOLDS.find(
		(candidate) => candidate.metricId === input.id,
	);
	if (!threshold) throw new Error(`Missing release threshold for ${input.id}`);
	return {
		...input,
		status: statusOf(input.value, input.denominator, threshold),
		threshold,
	};
}

/** Aggregate a content-free telemetry window into the release dashboard. */
export function buildCanvasReleaseDashboard(
	events: readonly CanvasTelemetryEvent[],
	options: { readonly generatedAt?: string } = {},
): CanvasReleaseDashboard {
	const byKey = (key: CanvasTelemetryEvent["key"]) =>
		events.filter((event) => event.key === key);
	const terminal = (event: CanvasTelemetryEvent) =>
		!["cancelled", "started"].includes(outcomeOf(event) ?? "");

	const loads = byKey("load");
	const saves = byKey("save");
	const exports = byKey("export").filter(terminal);
	const reconnects = byKey("collaboration").filter(
		(event) => payload(event).operation === "reconnect",
	);
	const aiJobs = byKey("aiJob").filter(terminal);
	const cancelCapable = [...byKey("export"), ...byKey("aiJob")].filter(
		(event) => outcomeOf(event) !== "started",
	);
	const errors = byKey("error");
	const operationalDenominator = Math.max(
		1,
		events.filter((event) => event.key !== "performance").length,
	);
	const performanceDurations = byKey("performance")
		.filter((event) => payload(event).phase === "input-to-preview")
		.map((event) => payload(event).durationMs)
		.filter((value): value is number => typeof value === "number");
	const resourceRejections = events.filter((event) =>
		["budget-rejection", "resource-rejection"].includes(
			errorClassOf(event) ?? "",
		),
	).length;
	const convergenceChecks = byKey("collaboration").filter(
		(event) => payload(event).operation === "convergence-check",
	);
	const convergenceFailures = convergenceChecks.filter(
		(event) => outcomeOf(event) !== "succeeded",
	).length;

	const metrics = [
		buildMetric({
			id: "load-success-rate",
			value: ratio(
				loads.filter((event) => outcomeOf(event) === "succeeded").length,
				loads.length,
			),
			numerator: loads.filter((event) => outcomeOf(event) === "succeeded")
				.length,
			denominator: loads.length,
		}),
		buildMetric({
			id: "save-success-rate",
			value: ratio(
				saves.filter((event) => outcomeOf(event) === "succeeded").length,
				saves.length,
			),
			numerator: saves.filter((event) => outcomeOf(event) === "succeeded")
				.length,
			denominator: saves.length,
		}),
		buildMetric({
			id: "export-success-rate",
			value: ratio(
				exports.filter((event) => outcomeOf(event) === "succeeded").length,
				exports.length,
			),
			numerator: exports.filter((event) => outcomeOf(event) === "succeeded")
				.length,
			denominator: exports.length,
		}),
		buildMetric({
			id: "unrecoverable-error-rate",
			value: ratio(
				errors.filter((event) => payload(event).recoverable === false).length,
				operationalDenominator,
			),
			numerator: errors.filter((event) => payload(event).recoverable === false)
				.length,
			denominator: operationalDenominator,
		}),
		buildMetric({
			id: "interaction-latency-p95-ms",
			value: p95(performanceDurations),
			numerator: performanceDurations.length,
			denominator: performanceDurations.length,
		}),
		buildMetric({
			id: "collaboration-reconnect-rate",
			value: ratio(
				reconnects.filter((event) => outcomeOf(event) === "succeeded").length,
				reconnects.length,
			),
			numerator: reconnects.filter((event) => outcomeOf(event) === "succeeded")
				.length,
			denominator: reconnects.length,
		}),
		buildMetric({
			id: "ai-job-success-rate",
			value: ratio(
				aiJobs.filter((event) => outcomeOf(event) === "succeeded").length,
				aiJobs.length,
			),
			numerator: aiJobs.filter((event) => outcomeOf(event) === "succeeded")
				.length,
			denominator: aiJobs.length,
		}),
		buildMetric({
			id: "cancellation-rate",
			value: ratio(
				cancelCapable.filter((event) => outcomeOf(event) === "cancelled")
					.length,
				cancelCapable.length,
			),
			numerator: cancelCapable.filter(
				(event) => outcomeOf(event) === "cancelled",
			).length,
			denominator: cancelCapable.length,
		}),
		buildMetric({
			id: "crash-rate",
			value: ratio(
				errors.filter((event) => payload(event).fatal === true).length,
				operationalDenominator,
			),
			numerator: errors.filter((event) => payload(event).fatal === true).length,
			denominator: operationalDenominator,
		}),
		buildMetric({
			id: "resource-rejection-rate",
			value: ratio(resourceRejections, operationalDenominator),
			numerator: resourceRejections,
			denominator: operationalDenominator,
		}),
		buildMetric({
			id: "collaboration-convergence-failures",
			value: convergenceFailures,
			numerator: convergenceFailures,
			denominator: convergenceChecks.length,
		}),
	] as const;

	const alerts = metrics.flatMap((metric): CanvasReleaseDashboardAlert[] => {
		if (metric.status !== "warning" && metric.status !== "critical") return [];
		return [
			{
				metricId: metric.id,
				owner: metric.threshold.owner,
				severity: metric.status,
				value: metric.value as number,
			},
		];
	});

	return {
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		eventCount: events.length,
		metrics,
		alerts,
	};
}
