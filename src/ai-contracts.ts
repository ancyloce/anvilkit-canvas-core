import type { CanvasAiPlaceholderStatus, CanvasNodeKind } from "./ir/types.js";

export interface AiImageTextToImageRequest {
	kind: "text-to-image";
	prompt: string;
	negativePrompt?: string;
	width?: number;
	height?: number;
	seed?: number;
}

export interface AiImageVariationRequest {
	kind: "variation";
	sourceAssetId: string;
	strength?: number;
	seed?: number;
}

export interface AiImageInpaintRequest {
	kind: "inpaint";
	sourceAssetId: string;
	maskAssetId: string;
	prompt: string;
	seed?: number;
}

export interface AiImageBgRemoveRequest {
	kind: "bg-remove";
	sourceAssetId: string;
}

export interface AiImageUpscaleRequest {
	kind: "upscale";
	sourceAssetId: string;
	/** Upscale factor (e.g. 2 or 4). The provider/route picks a default when omitted. */
	scale?: number;
}

/**
 * Creative, prompt-driven fill of a masked region (Firefly-"Generative Fill"
 * style) — distinct from {@link AiImageInpaintRequest}, which fills a masked
 * region to match its surroundings rather than introduce new prompted
 * content. Same field shape; the `kind` lets a provider route the two
 * differently even where its backing model treats them alike.
 */
export interface AiImageGenerativeFillRequest {
	kind: "generative-fill";
	sourceAssetId: string;
	maskAssetId: string;
	prompt: string;
	seed?: number;
}

/** Outpainting: extends the source image to a larger canvas (uncrop). */
export interface AiImageGenerativeExpandRequest {
	kind: "generative-expand";
	sourceAssetId: string;
	targetWidth: number;
	targetHeight: number;
	/** Guides what fills the newly-expanded area; omitted lets the provider extend the existing content naturally. */
	prompt?: string;
}

/** Removes the masked object and fills the gap to match its surroundings — no prompt, unlike {@link AiImageGenerativeFillRequest}. */
export interface AiImageObjectEraseRequest {
	kind: "object-erase";
	sourceAssetId: string;
	maskAssetId: string;
}

/** Replaces (not merely removes, unlike {@link AiImageBgRemoveRequest}) the background with prompt-generated content. */
export interface AiImageBackgroundReplaceRequest {
	kind: "background-replace";
	sourceAssetId: string;
	prompt: string;
	seed?: number;
}

export type AiImageJobRequest =
	| AiImageTextToImageRequest
	| AiImageVariationRequest
	| AiImageInpaintRequest
	| AiImageBgRemoveRequest
	| AiImageUpscaleRequest
	| AiImageGenerativeFillRequest
	| AiImageGenerativeExpandRequest
	| AiImageObjectEraseRequest
	| AiImageBackgroundReplaceRequest;

export type AiImageJobKind = AiImageJobRequest["kind"];

export type AiImageJobStatus = CanvasAiPlaceholderStatus | "cancelled";

export interface AiImageJobError {
	code: string;
	message: string;
}

interface AiImageJobResultBase {
	jobId: string;
	startedAt: number;
	finishedAt?: number;
}

/**
 * Status-discriminated (FR-050's failed-job invariant, canvas-m4-001):
 * `resultAssetId` exists ONLY on a `"complete"` result and `error` ONLY on an
 * `"error"` one, so it is a compile error — not just a documented
 * convention — to read an asset id off a job that didn't succeed. This is
 * additive over the pre-M4 flat shape: every existing construction site
 * already paired `status: "complete"` with `resultAssetId` and
 * `status: "error"` with `error`, so no real provider/consumer changes.
 */
export type AiImageJobResult =
	| (AiImageJobResultBase & { status: "pending" })
	| (AiImageJobResultBase & { status: "complete"; resultAssetId: string })
	| (AiImageJobResultBase & { status: "error"; error: AiImageJobError })
	| (AiImageJobResultBase & { status: "cancelled" });

export interface AiLayerBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface AiLayerContext {
	artboardId: string;
	selectedNodeId?: string;
	/**
	 * The selected node's kind (FR-053, canvas-m4-004) — lets a host UI
	 * decide whether an action that only makes sense for certain node kinds
	 * (e.g. rewriting text) applies to the current selection, without a
	 * second round-trip into the editor. Omitted means "unknown" (e.g. no
	 * selection, or a host that hasn't started populating it yet) — callers
	 * should not treat omission as "not a text node".
	 */
	selectedNodeKind?: CanvasNodeKind;
	bounds?: AiLayerBounds;
}

export interface AiImageProviderOptions {
	signal?: AbortSignal;
}

export type AiImageProvider = (
	request: AiImageJobRequest,
	context: AiLayerContext,
	options?: AiImageProviderOptions,
) => Promise<AiImageJobResult>;
