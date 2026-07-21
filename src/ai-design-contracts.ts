import type { AiImageJobKind, AiLayerContext } from "./ai-contracts.js";
import type { BrandKitDefinition } from "./brand/types.js";
import type {
	CanvasBatchCommand,
	CanvasCommand,
	CanvasPageCreateCommand,
} from "./commands/types.js";
import type { CanvasAiPlaceholderStatus, CanvasPage } from "./ir/types.js";
import {
	CanvasBoundsSchema,
	CanvasNodeSchema,
	CanvasPageSchema,
	CanvasTransformSchema,
} from "./ir/validators.js";
import type { CanvasSizePreset } from "./templates/types.js";

/**
 * Design-level AI job contracts (FR-050, canvas-m4-001) — a separate union
 * from `AiImageJobRequest` (`ai-contracts.ts`) because these ops are not
 * image-in/image-out: they read/produce whole pages, node content, or a
 * `BrandKitDefinition`/`CanvasSizePreset` reference, none of which fit that
 * union's shape. Ranked at 5 (alongside `serialize/`), not 2 like
 * `ai-contracts.ts` — it needs `templates/`/`brand/`/`commands/` (rank 3-4)
 * types, so it must outrank all three.
 *
 * Unlike `ai-contracts.ts`, this module is NOT types-only: canvas-m4-003's
 * `validateAiDesignJobResult` is real runtime validation logic (mirrors
 * `text-contracts.ts`'s `resolveSpanStyle`, another rank-appropriate contract
 * file that mixes types with a small amount of pure logic) — hence the root
 * barrel re-exports it with `export *`, not `export type *`.
 */
export interface AiPromptToDesignRequest {
	kind: "prompt-to-design";
	prompt: string;
	/** A `CanvasSizePreset.id`; omitted lets the provider choose a default canvas size. */
	presetId?: string;
}

/** Adapts an existing template to a prompt (e.g. "make me a fitness landing page") rather than generating from a blank canvas. */
export interface AiPromptToTemplateRequest {
	kind: "prompt-to-template";
	prompt: string;
	/** A specific `CanvasTemplateDefinition.id`; omitted lets the provider pick the best-fit template. */
	templateId?: string;
}

/** Rewrites one text/rich-text node's content in place. */
export interface AiRewriteCopyRequest {
	kind: "rewrite-copy";
	nodeId: string;
	/** Tone/style guidance, e.g. "make it punchier". */
	instruction?: string;
}

export interface AiGenerateHeadlineRequest {
	kind: "generate-headline";
	/** Free-text context the headline should reflect (page topic, audience, etc.). */
	context?: string;
	/** A text/rich-text node to place the generated headline into; omitted returns the string for the caller to place. */
	nodeId?: string;
}

/** Generates N alternative layouts from one source page — each candidate is a full `CanvasPage`, inspectable/editable like any other page. */
export interface AiGenerateLayoutVariantsRequest {
	kind: "generate-layout-variants";
	sourcePageId: string;
	count?: number;
}

/**
 * Applies a brand kit via an AI-inferred choice of transforms. The AI only
 * decides *which* of canvas-m2-006's `applyBrandColors`/`replaceFonts`/etc.
 * pure transforms to run and in what combination — the actual document
 * mutation always goes through those already-reversible, already-tested
 * functions, never a bespoke AI-authored edit.
 */
export interface AiApplyBrandRequest {
	kind: "apply-brand";
	brandKit: BrandKitDefinition;
	targetPageId?: string;
}

/** AI-initiated campaign resize — the design-level counterpart to canvas-m3-007's `resizeToVariants`, which a provider/adapter calls to fulfill this request. */
export interface AiResizeCampaignRequest {
	kind: "resize-campaign";
	sourcePageId: string;
	/** `CanvasSizePreset.id`s (`CANVAS_SIZE_PRESETS`) to resize to. */
	presetIds: readonly string[];
}

/** Bundles a campaign resize with prompt-driven content adaptation per variant (e.g. shortening copy to fit a square crop). */
export interface AiGenerateSocialPackRequest {
	kind: "generate-social-pack";
	sourcePageId: string;
	prompt?: string;
	/** Omitted defaults to the full `CANVAS_SIZE_PRESETS` catalog. */
	presetIds?: readonly string[];
}

export type AiDesignJobRequest =
	| AiPromptToDesignRequest
	| AiPromptToTemplateRequest
	| AiRewriteCopyRequest
	| AiGenerateHeadlineRequest
	| AiGenerateLayoutVariantsRequest
	| AiApplyBrandRequest
	| AiResizeCampaignRequest
	| AiGenerateSocialPackRequest;

export type AiDesignJobKind = AiDesignJobRequest["kind"];

export type AiDesignJobStatus = CanvasAiPlaceholderStatus | "cancelled";

export interface AiDesignJobError {
	code: string;
	message: string;
}

/**
 * What a completed design job produced — never a flattened raster. `command`
 * covers in-place edits to the CURRENT document (rewrite-copy,
 * generate-headline, apply-brand); `pages` covers ops that generate new
 * candidate pages (prompt-to-design, prompt-to-template,
 * generate-layout-variants, resize-campaign, generate-social-pack), inserted
 * as same-document pages exactly like `resizeToVariants`/`instantiateTemplate`
 * already do. Both must validate against the normal `CanvasIR`/command
 * schemas before ever reaching a real document (canvas-m4-003).
 */
export type AiDesignJobPayload =
	| { kind: "command"; command: CanvasCommand }
	| { kind: "pages"; pages: readonly CanvasPage[] };

interface AiDesignJobResultBase {
	jobId: string;
	startedAt: number;
	finishedAt?: number;
}

/**
 * Status-discriminated, matching `AiImageJobResult`'s FR-050 failed-job
 * invariant: `payload` exists ONLY on a `"complete"` result and `error` ONLY
 * on an `"error"` one — a failed or cancelled design job has no payload to
 * accidentally apply, enforced at compile time rather than by convention.
 */
export type AiDesignJobResult =
	| (AiDesignJobResultBase & { status: "pending" })
	| (AiDesignJobResultBase & {
			status: "complete";
			payload: AiDesignJobPayload;
	  })
	| (AiDesignJobResultBase & { status: "error"; error: AiDesignJobError })
	| (AiDesignJobResultBase & { status: "cancelled" });

export interface AiDesignProviderOptions {
	signal?: AbortSignal;
}

/**
 * Bare function type, deliberately mirroring `AiImageProvider` rather than
 * generalizing to an `AssetSourceProvider`-style object interface
 * (canvas-m4-002's recorded decision): `AiImageProvider` is already the
 * established, widely-consumed shape (mock + real Replicate adapter +
 * `AiJobClient`), and object-ifying it now would be a breaking change to
 * that existing surface for no behavioral gain — capability discovery
 * (below) is handled as sibling metadata instead of restructuring the
 * function itself.
 */
export type AiDesignProvider = (
	request: AiDesignJobRequest,
	context: AiLayerContext,
	options?: AiDesignProviderOptions,
) => Promise<AiDesignJobResult>;

/**
 * Which ops a given provider supports (FR-051) — sibling metadata a host
 * supplies alongside its `AiImageProvider`/`AiDesignProvider` functions,
 * since a bare function has no introspectable capabilities of its own. The
 * editor (canvas-m4-004) reads this to conditionally show/hide AI actions
 * rather than surfacing an action that will always fail for a given
 * provider. Omitting a list (vs. an empty array) means "unknown — assume
 * everything is supported", so pre-M4 hosts that don't yet supply
 * capabilities keep today's behavior.
 */
export interface AiProviderCapabilities {
	readonly imageOps?: readonly AiImageJobKind[];
	readonly designOps?: readonly AiDesignJobKind[];
}

/** A structured, user-facing reason an `AiDesignJobResult` was quarantined rather than applied. */
export interface AiDesignQuarantineError {
	readonly code: "job-not-complete" | "invalid-payload";
	readonly message: string;
	/** Zod issue messages, present only for `"invalid-payload"`. */
	readonly issues?: readonly string[];
}

export type ValidateAiDesignJobResultOutcome =
	| { readonly ok: true; readonly command: CanvasBatchCommand }
	| { readonly ok: false; readonly error: AiDesignQuarantineError };

/**
 * Every embedded node (`node.create`) / page (`page.create`) payload, plus
 * the numeric fields a `node.update` patch may carry, validated recursively
 * through a `batch`. Every other built-in command type is whitelisted
 * (returns no issues) rather than falling through a catch-all `default` — an
 * unrecognized `type` (a hostile or future-version AI payload cast to
 * `CanvasCommand`) is quarantined instead of silently passing (P1 C-2).
 */
function collectCommandValidationIssues(command: CanvasCommand): string[] {
	switch (command.type) {
		case "node.create": {
			const result = CanvasNodeSchema.safeParse(command.node);
			return result.success
				? []
				: result.error.issues.map((issue) => issue.message);
		}
		case "page.create": {
			const result = CanvasPageSchema.safeParse(command.page);
			return result.success
				? []
				: result.error.issues.map((issue) => issue.message);
		}
		case "node.update": {
			const issues: string[] = [];
			if (command.patch.transform !== undefined) {
				const result = CanvasTransformSchema.safeParse(command.patch.transform);
				if (!result.success) {
					issues.push(...result.error.issues.map((issue) => issue.message));
				}
			}
			if (command.patch.bounds !== undefined) {
				const result = CanvasBoundsSchema.safeParse(command.patch.bounds);
				if (!result.success) {
					issues.push(...result.error.issues.map((issue) => issue.message));
				}
			}
			return issues;
		}
		case "batch":
			return command.commands.flatMap(collectCommandValidationIssues);
		case "node.delete":
		case "node.reorder":
		case "node.reparent":
		case "node.move":
		case "node.resize":
		case "node.rotate":
		case "node.applyStyle":
		case "image.replace":
		case "node.group":
		case "node.ungroup":
		case "page.delete":
		case "page.reorder":
		case "page.rename":
		case "page.duplicate":
		case "page.resize":
		case "page.set-background":
		case "page.set-layout-aids":
		case "asset.put":
		case "asset.remove":
			// No embedded IR/document payload to schema-check — these commands
			// only reference existing ids and set primitive fields, which
			// `applyCommand` validates against live document state at apply time.
			return [];
		default:
			return [
				`Unrecognized command type "${(command as { type: string }).type}"`,
			];
	}
}

/**
 * Validates an `AiDesignJobResult`'s payload against the normal Canvas IR /
 * command schemas before it is safe to apply to a real document (FR-052,
 * canvas-m4-003). Pure — never mutates anything and never applies the
 * command itself; it only decides whether the payload is safe, normalizing
 * either payload shape to one ready-to-commit `CanvasBatchCommand`. A
 * non-`"complete"` job, or one whose payload fails validation, is
 * quarantined: this returns `ok: false` with a structured error rather than
 * silently dropping content or force-coercing it into the document.
 */
export function validateAiDesignJobResult(
	result: AiDesignJobResult,
): ValidateAiDesignJobResultOutcome {
	if (result.status !== "complete") {
		return {
			ok: false,
			error: {
				code: "job-not-complete",
				message: `AI design job "${result.jobId}" is not complete (status: "${result.status}") — nothing to apply.`,
			},
		};
	}

	const command: CanvasCommand =
		result.payload.kind === "command"
			? result.payload.command
			: ({
					type: "batch",
					commands: result.payload.pages.map(
						(page): CanvasPageCreateCommand => ({
							type: "page.create",
							page,
						}),
					),
				} satisfies CanvasBatchCommand);

	const issues = collectCommandValidationIssues(command);
	if (issues.length > 0) {
		return {
			ok: false,
			error: {
				code: "invalid-payload",
				message: `AI design job "${result.jobId}" produced an invalid payload — quarantined rather than applied.`,
				issues,
			},
		};
	}

	return {
		ok: true,
		command:
			command.type === "batch"
				? command
				: { type: "batch", commands: [command] },
	};
}
