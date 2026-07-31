/**
 * @file Export preparation (plan 0021 T-046/T-047, TD 0016 §18).
 *
 * ## What "preparation" means, and what it deliberately does not do
 *
 * It resolves the exact document that will be exported and reports everything
 * governance knows about it. It does **not** decide whether the export happens.
 * That is the host's call, made with {@link CanvasExportPreparation.exportWithWarnings}
 * and {@link CanvasExportPreparation.exportWithBlockingIssues} (T-046 step 6) —
 * because "may this brand-noncompliant asset ship" is a business question, and
 * a library that answered it would be wrong for half its users in each
 * direction.
 *
 * Two things are NOT the host's call, and fail preparation outright:
 *
 * 1. **Unresolvable content.** A missing or quarantined snapshot means the
 *    bytes to export do not exist. Exporting anyway would silently ship a
 *    placeholder where a component should be.
 * 2. **A flatten the policy forbids.** Flattening destroys the component link,
 *    which is exactly what `allowFlatten: false` / `allowDetach: false` exist
 *    to prevent; permitting it at export would make the whole policy
 *    circumventable by choosing a different output format.
 *
 * ## No network, structurally (T-046 DoD)
 *
 * This module imports no transport and takes no Provider, resolver, or fetch
 * callback — there is no parameter through which a network call could be
 * supplied. Resolution reads the document's own snapshot registry, which is why
 * an offline reopen exports identically to an online one. `prepare-export.test.ts`
 * asserts the absence structurally rather than by inspection.
 *
 * ## Never a `latest` lookup (T-046 step 2)
 *
 * Every Source resolves through the exact ref already in the document —
 * `libraryId/componentId/version/integrity`. There is no code path here that
 * consults a catalog, so a component republished since the document was saved
 * cannot change what a re-export produces.
 */

import type { BrandComplianceReport } from "../brand/compliance.js";
import type { BrandKitDefinition } from "../brand/index.js";
import { getDefinition } from "../components/definition-lookup.js";
import { buildExternalSnapshotIndex } from "../components/snapshot-index.js";
import type { CanvasComponentIssue } from "../components/types.js";
import { validateComponentGraph } from "../components/validate.js";
import { resolveInlineExportDocument } from "../export/resolve.js";
import type { CanvasExportJobSource } from "../export/types.js";
import type { CanvasIR, CanvasNode } from "../ir/types.js";
import { createBrandPolicyEvaluator } from "./command-policy.js";
import { generateGovernedComplianceReport } from "./compliance.js";
import type { CanvasBrandPolicyContext } from "./types.js";

/** Why preparation refused. Stable codes — never localized copy. */
export type CanvasExportPreparationErrorCode =
	/** The source was a `documentRef`; core does not resolve refs (OD-09). */
	| "document-ref-unresolved"
	/** The payload is not a valid document at the current IR version. */
	| "document-invalid"
	/** A component Source has no usable snapshot, or its closure is incomplete. */
	| "component-unresolved"
	/** A flatten was requested that policy forbids. */
	| "flatten-denied";

export interface CanvasExportPreparationOptions {
	/** The effective host policy context. */
	readonly context: CanvasBrandPolicyContext;
	/** Brand Kit to measure compliance against. Omitted means no report. */
	readonly brandKit?: BrandKitDefinition;
	/**
	 * Snapshot keys quarantined at load (T-045).
	 *
	 * Passed in rather than recomputed: verification is asynchronous and lives
	 * in the Editor, while preparation is synchronous and lives here. A caller
	 * that forgets is not silently trusting bad bytes — the snapshot is still
	 * present, so the export would succeed with unverified content, which is why
	 * the Editor's export action threads this through and a test covers it.
	 */
	readonly quarantinedKeys?: readonly string[];
	/**
	 * Whether this export flattens components into plain layers.
	 *
	 * Defaults to `false`. A format that inherently flattens (raster, flattened
	 * SVG) must pass `true` — that is what makes `allowFlatten: false`
	 * meaningful for a PNG rather than only for the Detach button.
	 */
	readonly flatten?: boolean;
}

export interface CanvasExportPreparationSuccess {
	readonly ok: true;
	/** The exact document to export — validated, migrated, resolvable. */
	readonly document: CanvasIR;
	/** Present when a Brand Kit was supplied. */
	readonly report?: BrandComplianceReport;
	/** Non-blocking findings exist. The host decides. */
	readonly exportWithWarnings: boolean;
	/** Blocking findings exist. The host decides. */
	readonly exportWithBlockingIssues: boolean;
}

export interface CanvasExportPreparationFailure {
	readonly ok: false;
	readonly code: CanvasExportPreparationErrorCode;
	readonly message: string;
	/** Component diagnostics behind a `component-unresolved` refusal. */
	readonly issues?: readonly CanvasComponentIssue[];
	/** Instances behind a `flatten-denied` refusal. */
	readonly instanceIds?: readonly string[];
}

export type CanvasExportPreparation =
	| CanvasExportPreparationSuccess
	| CanvasExportPreparationFailure;

function fail(
	code: CanvasExportPreparationErrorCode,
	message: string,
	extra: Omit<CanvasExportPreparationFailure, "ok" | "code" | "message"> = {},
): CanvasExportPreparationFailure {
	return { ok: false, code, message, ...extra };
}

/** Every component instance on a page, in document order. */
function componentInstances(ir: CanvasIR): CanvasNode[] {
	const out: CanvasNode[] = [];
	for (const page of ir.pages) {
		const stack: CanvasNode[] = [page.root];
		while (stack.length > 0) {
			const node = stack.pop() as CanvasNode;
			if (node.type === "component-instance") out.push(node);
			const children = (node as { children?: readonly CanvasNode[] }).children;
			if (children) stack.push(...children);
		}
	}
	return out;
}

/**
 * Prepare a document for export under a policy context.
 *
 * Synchronous and total: every refusal is a returned code, never a throw,
 * because export runs in a worker where an exception is a lost job rather than
 * a message a user can act on. The one exception is the `documentRef` source,
 * which is a *programming* error on the host's side and is reported as a
 * refusal here rather than by throwing from `resolveInlineExportDocument`.
 */
export function prepareExport(
	source: CanvasExportJobSource,
	options: CanvasExportPreparationOptions,
): CanvasExportPreparation {
	// 1. Resolve the source. A `documentRef` is the host's obligation (OD-09,
	//    AC-015): a worker that resolves one must re-enter THIS function with
	//    `{ document }`, or it skips every check below.
	if (!("document" in source)) {
		return fail(
			"document-ref-unresolved",
			"CanvasExportJobSource.documentRef must be resolved by the host or worker and passed back to prepareExport as { document } — canvas-core does not resolve refs, and a worker that exports a ref directly bypasses component resolution and the compliance report.",
		);
	}

	let document: CanvasIR;
	try {
		document = resolveInlineExportDocument(source);
	} catch (error) {
		return fail(
			"document-invalid",
			error instanceof Error ? error.message : String(error),
		);
	}

	// 2. Resolve every Source from the document's own snapshots — never a
	//    catalog, never a `latest` lookup.
	const external = buildExternalSnapshotIndex(
		document.externalComponentSnapshots,
		options.quarantinedKeys ? { quarantinedKeys: options.quarantinedKeys } : {},
	);
	const unresolved: string[] = [];
	for (const instance of componentInstances(document)) {
		const lookup = getDefinition(
			(instance as { source: Parameters<typeof getDefinition>[0] }).source,
			document.components,
			external,
		);
		if (lookup.kind === "unresolved") unresolved.push(instance.id);
	}

	// 3. Graph, variants and overrides. ERROR severity only — a warning (an
	//    orphaned override, say) is a normal state and must not fail an export.
	const graphIssues = validateComponentGraph(document);
	const graphErrors = graphIssues.filter((issue) => issue.severity === "error");

	if (unresolved.length > 0 || graphErrors.length > 0) {
		return fail(
			"component-unresolved",
			unresolved.length > 0
				? `${unresolved.length} component instance(s) have no usable snapshot: ${unresolved.join(", ")}. Export would ship placeholders.`
				: `The component graph has ${graphErrors.length} blocking issue(s).`,
			{ issues: graphErrors },
		);
	}

	// 4. Flatten, when the export flattens. Asked per instance because policy is
	//    an intersection down the instance path (OD-08) — a nested instance can
	//    forbid what its parent permits.
	if (options.flatten) {
		const evaluate = createBrandPolicyEvaluator(document);
		const denied = componentInstances(document)
			.filter(
				(instance) =>
					evaluate(
						{ operation: "flatten", instanceId: instance.id },
						options.context,
					).outcome === "deny",
			)
			.map((instance) => instance.id);
		if (denied.length > 0) {
			return fail(
				"flatten-denied",
				`Brand policy forbids flattening ${denied.length} instance(s). Export in a format that preserves components, or remove them.`,
				{ instanceIds: denied },
			);
		}
	}

	// 5. Compliance. Returned on BOTH allow and block (T-046 step 3) — a host
	//    that blocks still has to tell the user what to fix.
	const report = options.brandKit
		? generateGovernedComplianceReport(
				document,
				options.brandKit,
				options.context,
			)
		: undefined;

	return {
		ok: true,
		document,
		...(report ? { report } : {}),
		exportWithWarnings: (report?.summary?.warning ?? 0) > 0,
		exportWithBlockingIssues: (report?.summary?.blocking ?? 0) > 0,
	};
}
