import type { CanvasCommandErrorCode } from "../commands/runtime.js";

/**
 * Stable component-library diagnostics (plan 0021 T-011, PRD 0016 §9.16).
 *
 * # Diagnostics are REPORTED; command errors are THROWN
 *
 * This is the distinction the two unions encode, and it is not cosmetic:
 *
 * - A **diagnostic** describes a document that already exists and is being read.
 *   A snapshot is missing, a version is deprecated, the Provider is offline. The
 *   document stays open, the affected instance renders a placeholder or a stale
 *   state, and the UI surfaces the code. Nothing is rolled back because nothing
 *   was being changed.
 * - A **`CanvasCommandErrorCode`** aborts a mutation. Command application is
 *   synchronous and atomic (`commands/runtime.ts`), so the only way to refuse a
 *   change is to throw before any mutation lands.
 *
 * Four codes appear in both unions, because the same condition means different
 * things depending on when it is noticed: `component-snapshot-missing` found
 * while *rendering* is a diagnostic, but found while *inserting an instance* it
 * must abort the insert. {@link CANVAS_COMPONENT_ABORTING_CODES} names that
 * overlap explicitly and a type-level assertion below keeps the two unions from
 * drifting apart.
 */

/** Every stable diagnostic code, in PRD §9.16 order. */
export const CANVAS_COMPONENT_DIAGNOSTIC_CODES = [
	"component-provider-offline",
	"component-provider-unauthorized",
	"component-version-missing",
	"component-version-deprecated",
	"component-integrity-mismatch",
	"component-snapshot-missing",
	"component-snapshot-invalid",
	"component-dependency-missing",
	"component-update-incompatible",
	"component-variant-invalid",
	"component-swap-incompatible",
	"component-override-migration-orphan",
	"component-library-capability-denied",
] as const;

/**
 * A closed union — deliberately not `string`.
 *
 * PRD §9.16 acceptance: "No `string` typed error codes anywhere in the new
 * surface." A closed union is what makes a `switch` over diagnostics
 * exhaustively checkable, so adding a code forces every consumer (UI message
 * catalogue, analytics mapper, compliance panel) to acknowledge it at compile
 * time rather than falling through to a generic "unknown error".
 */
export type CanvasComponentDiagnosticCode =
	(typeof CANVAS_COMPONENT_DIAGNOSTIC_CODES)[number];

/**
 * The subset of diagnostics that must also abort a command.
 *
 * These are the conditions under which continuing would write something invalid
 * into the document, so they exist in `CanvasCommandErrorCode` too and are thrown
 * from command application. `brand-policy-denied` is the fifth aborting code but
 * is NOT a component diagnostic — it belongs to brand governance (M4), which
 * reports policy findings through the compliance report rather than through this
 * union.
 */
export const CANVAS_COMPONENT_ABORTING_CODES = [
	"component-library-capability-denied",
	"component-integrity-mismatch",
	"component-snapshot-missing",
	"component-dependency-missing",
] as const;

export type CanvasComponentAbortingCode =
	(typeof CANVAS_COMPONENT_ABORTING_CODES)[number];

/**
 * Compile-time proof that the overlap is real in both directions.
 *
 * If someone renames a code in one union and not the other, or drops one of these
 * from `CanvasCommandErrorCode`, this stops compiling — which is the only way two
 * unions in two files stay in agreement without a runtime check nobody runs.
 */
type AssertExtends<Narrow extends Wide, Wide> = Narrow;

/** Every aborting code is a component diagnostic. */
export type _AbortingCodesAreDiagnostics = AssertExtends<
	CanvasComponentAbortingCode,
	CanvasComponentDiagnosticCode
>;

/** Every aborting code is also a command error code. */
export type _AbortingCodesAreCommandErrors = AssertExtends<
	CanvasComponentAbortingCode,
	CanvasCommandErrorCode
>;

/** Whether `code` is one of the stable component diagnostics. */
export function isCanvasComponentDiagnosticCode(
	code: unknown,
): code is CanvasComponentDiagnosticCode {
	return (
		typeof code === "string" &&
		(CANVAS_COMPONENT_DIAGNOSTIC_CODES as readonly string[]).includes(code)
	);
}

/** Whether a diagnostic condition must abort the command that hit it. */
export function isCanvasComponentAbortingCode(
	code: unknown,
): code is CanvasComponentAbortingCode {
	return (
		typeof code === "string" &&
		(CANVAS_COMPONENT_ABORTING_CODES as readonly string[]).includes(code)
	);
}

/**
 * How badly a diagnostic affects the document.
 *
 * `error` — the instance cannot render from stored data (missing or invalid
 * snapshot, missing dependency, integrity failure).
 * `warning` — it renders, but something needs attention (deprecated version,
 * an orphaned override after a migration, a variant that fell back).
 * `info` — an environmental condition with no effect on stored content
 * (Provider offline while the snapshot still renders fine).
 */
export type CanvasComponentDiagnosticSeverity = "error" | "warning" | "info";

const SEVERITY_BY_CODE: Readonly<
	Record<CanvasComponentDiagnosticCode, CanvasComponentDiagnosticSeverity>
> = {
	// Environmental: the document is unaffected because the snapshot is authority.
	"component-provider-offline": "info",
	"component-provider-unauthorized": "info",
	// The stored snapshot cannot be trusted or found — nothing can render.
	"component-integrity-mismatch": "error",
	"component-snapshot-missing": "error",
	"component-snapshot-invalid": "error",
	"component-dependency-missing": "error",
	"component-library-capability-denied": "error",
	// Renders, but degraded or in need of a decision.
	"component-version-missing": "warning",
	"component-version-deprecated": "warning",
	"component-update-incompatible": "warning",
	"component-swap-incompatible": "warning",
	"component-variant-invalid": "warning",
	"component-override-migration-orphan": "warning",
};

/** The documented severity for a diagnostic code. */
export function componentDiagnosticSeverity(
	code: CanvasComponentDiagnosticCode,
): CanvasComponentDiagnosticSeverity {
	return SEVERITY_BY_CODE[code];
}

/**
 * One reported diagnostic.
 *
 * Intentionally minimal in M0. The resolution-state carrier that attaches these
 * to a specific instance and snapshot (`CanvasExternalComponentState`,
 * TD §17.1) lands in M1/T-016; this is the shape it will carry.
 *
 * `message` is developer-facing English for logs and diagnostics panels. It is
 * **not** the user-facing string — that is looked up from `code` in the Editor's
 * four locale catalogues, which is the whole reason `code` is a closed union.
 */
export interface CanvasComponentDiagnostic {
	code: CanvasComponentDiagnosticCode;
	/** Developer-facing detail. Never rendered to end users; never localized. */
	message: string;
	/** Severity, defaulting to {@link componentDiagnosticSeverity} for `code`. */
	severity?: CanvasComponentDiagnosticSeverity;
	/** Snapshot key this concerns, when it concerns one. */
	snapshotKey?: string;
	/** Instance node id this concerns, when it concerns one. */
	nodeId?: string;
}

/** Build a diagnostic, defaulting `severity` from the code. */
export function componentDiagnostic(
	code: CanvasComponentDiagnosticCode,
	message: string,
	context: Omit<CanvasComponentDiagnostic, "code" | "message" | "severity"> & {
		severity?: CanvasComponentDiagnosticSeverity;
	} = {},
): CanvasComponentDiagnostic {
	return {
		code,
		message,
		severity: context.severity ?? componentDiagnosticSeverity(code),
		...(context.snapshotKey === undefined
			? {}
			: { snapshotKey: context.snapshotKey }),
		...(context.nodeId === undefined ? {} : { nodeId: context.nodeId }),
	};
}
