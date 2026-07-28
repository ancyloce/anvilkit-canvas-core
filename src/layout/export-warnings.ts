import type {
	CanvasExportWarning,
	CanvasExportWarningLevel,
} from "../export/types.js";
import type {
	CanvasLayoutIssue,
	CanvasLayoutIssueSeverity,
} from "./validate.js";

/**
 * @file T-M3-03 — layout diagnostics in export results.
 *
 * `CanvasExportWarning.code` is deliberately an open `string` so the export
 * contracts (rank 2) never depend on per-domain taxonomies — and `export/`
 * cannot import this domain (rank 4) anyway. The mapping therefore lives on
 * the layout side, and every host that surfaces layout diagnostics in an
 * export result routes through this ONE function, so `severity` → `level`
 * and the carried fields cannot drift per host.
 */

const LEVEL_BY_SEVERITY: Readonly<
	Record<CanvasLayoutIssueSeverity, CanvasExportWarningLevel>
> = {
	warning: "warn",
	error: "error",
};

/** Options for {@link layoutIssuesToExportWarnings}. */
export interface LayoutIssuesToExportWarningsOptions {
	/** Stamped onto every warning, for per-page export batches. */
	readonly pageId?: string;
}

/**
 * Map layout diagnostics into the unified export-warning shape 1:1 — `code`
 * carries the issue code verbatim (the same convention the SVG/PDF serializer
 * warnings use), `severity` maps to `level`, and `nodeId`/`fallback` ride
 * along when present.
 */
export function layoutIssuesToExportWarnings(
	issues: readonly CanvasLayoutIssue[],
	options: LayoutIssuesToExportWarningsOptions = {},
): CanvasExportWarning[] {
	return issues.map((issue) => ({
		level: LEVEL_BY_SEVERITY[issue.severity],
		code: issue.code,
		message: issue.message,
		...(issue.nodeId !== undefined ? { nodeId: issue.nodeId } : {}),
		...(options.pageId !== undefined ? { pageId: options.pageId } : {}),
		...(issue.fallback !== undefined ? { fallback: issue.fallback } : {}),
	}));
}
