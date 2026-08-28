import { CanvasExportLimitError } from "./cost.js";
import type { CanvasExportWarning, CanvasExportWarningLevel } from "./types.js";

export type CanvasExportDiagnosticCategory =
	| "unsupported-format"
	| "budget-rejection"
	| "missing-asset"
	| "missing-font"
	| "provider-failure"
	| "cancellation"
	| "rendering-failure";

export type CanvasExportDiagnosticCode =
	| "CANVAS_EXPORT_UNSUPPORTED_FORMAT"
	| "CANVAS_EXPORT_BUDGET_EXCEEDED"
	| "CANVAS_EXPORT_MISSING_ASSET"
	| "CANVAS_EXPORT_MISSING_FONT"
	| "CANVAS_EXPORT_PROVIDER_FAILED"
	| "CANVAS_EXPORT_CANCELLED"
	| "CANVAS_EXPORT_RENDER_FAILED";

export interface CanvasExportDiagnostic {
	readonly code: CanvasExportDiagnosticCode;
	readonly category: CanvasExportDiagnosticCategory;
	readonly level: CanvasExportWarningLevel;
	readonly message: string;
	readonly correctiveAction: string;
	/** More specific originating code, such as `MISSING_ASSET` or a limit factor. */
	readonly sourceCode?: string;
	readonly nodeId?: string;
	readonly pageId?: string;
}

export interface CreateCanvasExportDiagnosticOptions {
	readonly level?: CanvasExportWarningLevel;
	readonly message?: string;
	readonly correctiveAction?: string;
	readonly sourceCode?: string;
	readonly nodeId?: string;
	readonly pageId?: string;
}

const CODE_BY_CATEGORY: Record<
	CanvasExportDiagnosticCategory,
	CanvasExportDiagnosticCode
> = {
	"unsupported-format": "CANVAS_EXPORT_UNSUPPORTED_FORMAT",
	"budget-rejection": "CANVAS_EXPORT_BUDGET_EXCEEDED",
	"missing-asset": "CANVAS_EXPORT_MISSING_ASSET",
	"missing-font": "CANVAS_EXPORT_MISSING_FONT",
	"provider-failure": "CANVAS_EXPORT_PROVIDER_FAILED",
	cancellation: "CANVAS_EXPORT_CANCELLED",
	"rendering-failure": "CANVAS_EXPORT_RENDER_FAILED",
};

const DEFAULTS: Record<
	CanvasExportDiagnosticCategory,
	{ readonly message: string; readonly correctiveAction: string }
> = {
	"unsupported-format": {
		message: "The requested export format is not supported.",
		correctiveAction: "Choose one of the registered export formats.",
	},
	"budget-rejection": {
		message: "The export exceeds its configured resource budget.",
		correctiveAction: "Reduce page count, dimensions, or export scale.",
	},
	"missing-asset": {
		message: "An asset required by the export is missing.",
		correctiveAction:
			"Restore or replace the missing asset, then export again.",
	},
	"missing-font": {
		message: "A font required by the export is unavailable.",
		correctiveAction:
			"Provide the font or replace it with an available family.",
	},
	"provider-failure": {
		message: "The configured export provider failed.",
		correctiveAction: "Check the provider configuration or retry later.",
	},
	cancellation: {
		message: "The export was cancelled.",
		correctiveAction: "Start the export again when ready.",
	},
	"rendering-failure": {
		message: "The export renderer failed.",
		correctiveAction:
			"Retry at a lower scale or inspect the document for unsupported content.",
	},
};

/** Construct one stable, serializable diagnostic with a safe corrective action. */
export function createCanvasExportDiagnostic(
	category: CanvasExportDiagnosticCategory,
	options: CreateCanvasExportDiagnosticOptions = {},
): CanvasExportDiagnostic {
	const defaults = DEFAULTS[category];
	return {
		code: CODE_BY_CATEGORY[category],
		category,
		level: options.level ?? "error",
		message: options.message ?? defaults.message,
		correctiveAction: options.correctiveAction ?? defaults.correctiveAction,
		...(options.sourceCode ? { sourceCode: options.sourceCode } : {}),
		...(options.nodeId ? { nodeId: options.nodeId } : {}),
		...(options.pageId ? { pageId: options.pageId } : {}),
	};
}

const MISSING_ASSET_CODES = new Set([
	"MISSING_ASSET",
	"LOCAL_ASSET_NOT_PORTABLE",
	"LOCAL_ASSET_VOLATILE_STORE",
]);
const MISSING_FONT_CODES = new Set([
	"FONT_NOT_IN_MANIFEST",
	"PRINT_FONT_MISSING",
	"PRINT_FONT_UNRESOLVED",
]);

/** Normalize an existing fidelity/preflight warning into the stable taxonomy. */
export function canvasExportDiagnosticForWarning(
	warning: CanvasExportWarning,
): CanvasExportDiagnostic {
	const category: CanvasExportDiagnosticCategory = MISSING_ASSET_CODES.has(
		warning.code,
	)
		? "missing-asset"
		: MISSING_FONT_CODES.has(warning.code)
			? "missing-font"
			: "rendering-failure";
	return createCanvasExportDiagnostic(category, {
		level: warning.level,
		message: warning.message,
		correctiveAction: warning.fallback ?? DEFAULTS[category].correctiveAction,
		sourceCode: warning.code,
		...(warning.nodeId ? { nodeId: warning.nodeId } : {}),
		...(warning.pageId ? { pageId: warning.pageId } : {}),
	});
}

export function canvasExportDiagnosticsForWarnings(
	warnings: readonly CanvasExportWarning[],
): CanvasExportDiagnostic[] {
	return warnings.map(canvasExportDiagnosticForWarning);
}

export interface NormalizeCanvasExportErrorContext {
	/** Runtime format value when no exporter registration exists. */
	readonly unsupportedFormat?: string;
	/** Explicit cancellation evidence; checked before generic error shape. */
	readonly cancelled?: boolean;
	/** Whether an injected provider or a built-in renderer was executing. */
	readonly source?: "provider" | "renderer";
}

function messageFrom(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.trim()
		? error.message
		: fallback;
}

/** Classify a thrown export failure without depending on browser/editor types. */
export function normalizeCanvasExportError(
	error: unknown,
	context: NormalizeCanvasExportErrorContext = {},
): CanvasExportDiagnostic {
	if (context.cancelled) {
		return createCanvasExportDiagnostic("cancellation", {
			message: messageFrom(error, DEFAULTS.cancellation.message),
		});
	}
	if (context.unsupportedFormat) {
		return createCanvasExportDiagnostic("unsupported-format", {
			message: `No exporter is registered for format "${context.unsupportedFormat}".`,
			sourceCode: context.unsupportedFormat,
		});
	}
	if (
		error instanceof CanvasExportLimitError ||
		(error !== null &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "CANVAS_EXPORT_BUDGET_EXCEEDED")
	) {
		const violation =
			error instanceof CanvasExportLimitError ? error.violations[0] : undefined;
		return createCanvasExportDiagnostic("budget-rejection", {
			message: messageFrom(error, DEFAULTS["budget-rejection"].message),
			correctiveAction:
				violation?.safeAction ?? DEFAULTS["budget-rejection"].correctiveAction,
			...(violation ? { sourceCode: violation.code } : {}),
		});
	}
	if (context.source === "provider") {
		return createCanvasExportDiagnostic("provider-failure", {
			message: messageFrom(error, DEFAULTS["provider-failure"].message),
		});
	}
	return createCanvasExportDiagnostic("rendering-failure", {
		message: messageFrom(error, DEFAULTS["rendering-failure"].message),
	});
}

/** Error wrapper for code paths that previously threw an untyped `Error`. */
export class CanvasExportDiagnosticError extends Error {
	readonly code: CanvasExportDiagnosticCode;
	readonly diagnostic: CanvasExportDiagnostic;

	constructor(diagnostic: CanvasExportDiagnostic, cause?: unknown) {
		super(diagnostic.message, cause === undefined ? undefined : { cause });
		this.name = "CanvasExportDiagnosticError";
		this.code = diagnostic.code;
		this.diagnostic = diagnostic;
	}
}
