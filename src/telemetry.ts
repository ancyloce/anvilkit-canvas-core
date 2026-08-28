/** Privacy-reviewed telemetry schema version. */
export const CANVAS_TELEMETRY_SCHEMA_VERSION = 1 as const;

export const CANVAS_TELEMETRY_EVENTS = {
	load: "anvilkit.canvas.telemetry.load",
	save: "anvilkit.canvas.telemetry.save",
	recovery: "anvilkit.canvas.telemetry.recovery",
	export: "anvilkit.canvas.telemetry.export",
	collaboration: "anvilkit.canvas.telemetry.collaboration",
	aiJob: "anvilkit.canvas.telemetry.ai_job",
	performance: "anvilkit.canvas.telemetry.performance",
	error: "anvilkit.canvas.telemetry.error",
} as const;

export type CanvasTelemetryEventKey = keyof typeof CANVAS_TELEMETRY_EVENTS;
export type CanvasTelemetryEventName =
	(typeof CANVAS_TELEMETRY_EVENTS)[CanvasTelemetryEventKey];

export type CanvasTelemetryOutcome =
	| "cancelled"
	| "failed"
	| "rejected"
	| "started"
	| "succeeded"
	| "timed-out";

/** Stable, content-free error classes used by dashboards and alert routing. */
export type CanvasTelemetryErrorClass =
	| "authorization"
	| "budget-rejection"
	| "cancellation"
	| "collaboration-convergence"
	| "document-input"
	| "migration"
	| "network"
	| "provider"
	| "rendering"
	| "resource-rejection"
	| "storage"
	| "timeout"
	| "unknown";

export type CanvasTelemetryNodeCountBucket =
	| "0-99"
	| "100-999"
	| "1000-4999"
	| "5000-plus";

export interface CanvasTelemetryPayloads {
	readonly load: {
		readonly outcome: Exclude<CanvasTelemetryOutcome, "cancelled" | "started">;
		readonly origin:
			| "collaboration-snapshot"
			| "import"
			| "initial-ir"
			| "persistence"
			| "recovery"
			| "template";
		readonly durationMs: number;
		readonly nodeCountBucket: CanvasTelemetryNodeCountBucket;
		readonly errorClass?: CanvasTelemetryErrorClass;
		readonly errorCode?: string;
	};
	readonly save: {
		readonly outcome: Exclude<CanvasTelemetryOutcome, "rejected" | "started">;
		readonly trigger: "auto" | "manual" | "unload";
		readonly durationMs: number;
		readonly errorClass?: CanvasTelemetryErrorClass;
		readonly errorCode?: string;
	};
	readonly recovery: {
		readonly operation: "clear" | "read" | "restore" | "write";
		readonly outcome: Exclude<CanvasTelemetryOutcome, "started">;
		readonly durationMs: number;
		readonly errorClass?: CanvasTelemetryErrorClass;
		readonly errorCode?: string;
	};
	readonly export: {
		readonly format:
			| "jpeg"
			| "json"
			| "pdf"
			| "pdf-print"
			| "png"
			| "svg"
			| "webp";
		readonly outcome: Exclude<CanvasTelemetryOutcome, "started">;
		readonly durationMs: number;
		readonly pageCount: number;
		readonly errorClass?: CanvasTelemetryErrorClass;
		readonly errorCode?: string;
	};
	readonly collaboration: {
		readonly operation: "connect" | "convergence-check" | "reconnect" | "sync";
		readonly outcome: Exclude<CanvasTelemetryOutcome, "cancelled" | "started">;
		readonly durationMs: number;
		readonly attempt: number;
		readonly errorClass?: CanvasTelemetryErrorClass;
		readonly errorCode?: string;
	};
	readonly aiJob: {
		readonly capability: "design" | "image" | "writing";
		readonly outcome: CanvasTelemetryOutcome;
		readonly durationMs?: number;
		readonly providerKind: "host" | "mock" | "remote";
		readonly errorClass?: CanvasTelemetryErrorClass;
		readonly errorCode?: string;
	};
	readonly performance: {
		readonly interaction:
			| "color-adjustment"
			| "drag"
			| "load"
			| "property-scrub"
			| "resize"
			| "rotate"
			| "thumbnail";
		readonly phase:
			| "commit"
			| "input-to-preview"
			| "layout"
			| "resolve"
			| "stage-update"
			| "thumbnail-invalidation";
		readonly durationMs: number;
		readonly nodeCountBucket: CanvasTelemetryNodeCountBucket;
		readonly fixtureId?: string;
	};
	readonly error: {
		readonly boundary:
			| "ai-job"
			| "collaboration"
			| "export"
			| "load"
			| "migration"
			| "recovery"
			| "render"
			| "save";
		readonly classification: CanvasTelemetryErrorClass;
		readonly code: string;
		readonly recoverable: boolean;
		readonly fatal: boolean;
	};
}

export interface CanvasTelemetryContext {
	/** Released package/application version, never a user or document identifier. */
	readonly release: string;
	/** E0-T2 environment ID when the event belongs to a reference run. */
	readonly environmentId?: string;
	readonly occurredAt?: string;
}

export interface CanvasTelemetryEvent<
	K extends CanvasTelemetryEventKey = CanvasTelemetryEventKey,
> {
	readonly schemaVersion: typeof CANVAS_TELEMETRY_SCHEMA_VERSION;
	readonly key: K;
	readonly name: (typeof CANVAS_TELEMETRY_EVENTS)[K];
	readonly occurredAt: string;
	readonly release: string;
	readonly environmentId?: string;
	readonly properties: CanvasTelemetryPayloads[K];
}

export type CanvasTelemetrySink = (event: CanvasTelemetryEvent) => void;

export type CanvasTelemetryEmissionResult =
	| "dropped-unsafe"
	| "emitted"
	| "no-sink"
	| "sink-failed";

const FORBIDDEN_FIELD =
	/(?:^|_)(?:actor|asset|authorization|binary|content|cookie|document|email|identity|image|media|name|password|personal|prompt|secret|text|token|uri|url|user)(?:$|_)/i;
const URL_OR_DATA = /(?:https?:\/\/|data:|blob:|file:|javascript:)/i;
const EMAIL = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;

/**
 * Return privacy violations without including the offending value in output.
 * Raw design content, prompts, tokens, binary data, URLs, and identity fields
 * are rejected even when a caller bypasses the TypeScript contract.
 */
export function inspectCanvasTelemetrySafety(
	value: unknown,
): readonly string[] {
	const issues: string[] = [];
	const visit = (current: unknown, path: string): void => {
		if (typeof current === "string") {
			if (current.length > 128)
				issues.push(`${path}: string exceeds 128 characters`);
			if (URL_OR_DATA.test(current))
				issues.push(`${path}: URL or encoded data forbidden`);
			if (EMAIL.test(current))
				issues.push(`${path}: personal identifier forbidden`);
			return;
		}
		if (Array.isArray(current)) {
			current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
			return;
		}
		if (!current || typeof current !== "object") return;
		for (const [key, entry] of Object.entries(current)) {
			const nextPath = path ? `${path}.${key}` : key;
			if (FORBIDDEN_FIELD.test(key) && nextPath !== "event.name") {
				issues.push(`${nextPath}: forbidden telemetry field`);
				continue;
			}
			visit(entry, nextPath);
		}
	};
	visit(value, "event");
	return issues;
}

/** Construct a typed event using the privacy-reviewed wire vocabulary. */
export function canvasTelemetryEvent<K extends CanvasTelemetryEventKey>(
	key: K,
	properties: CanvasTelemetryPayloads[K],
	context: CanvasTelemetryContext,
): CanvasTelemetryEvent<K> {
	return {
		schemaVersion: CANVAS_TELEMETRY_SCHEMA_VERSION,
		key,
		name: CANVAS_TELEMETRY_EVENTS[key],
		occurredAt: context.occurredAt ?? new Date().toISOString(),
		release: context.release,
		...(context.environmentId !== undefined
			? { environmentId: context.environmentId }
			: {}),
		properties,
	};
}

/**
 * Emit without making telemetry load-bearing. Unsafe events are dropped before
 * reaching the host sink; a throwing sink cannot break the user operation.
 */
export function emitCanvasTelemetry(
	sink: CanvasTelemetrySink | undefined,
	event: CanvasTelemetryEvent,
): CanvasTelemetryEmissionResult {
	if (!sink) return "no-sink";
	if (inspectCanvasTelemetrySafety(event).length > 0) return "dropped-unsafe";
	try {
		sink(event);
		return "emitted";
	} catch {
		return "sink-failed";
	}
}
