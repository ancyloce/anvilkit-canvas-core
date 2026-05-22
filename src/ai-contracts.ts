import type { CanvasAiPlaceholderStatus } from "./types.js";

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

export type AiImageJobRequest =
	| AiImageTextToImageRequest
	| AiImageVariationRequest
	| AiImageInpaintRequest
	| AiImageBgRemoveRequest
	| AiImageUpscaleRequest;

export type AiImageJobKind = AiImageJobRequest["kind"];

export type AiImageJobStatus = CanvasAiPlaceholderStatus | "cancelled";

export interface AiImageJobError {
	code: string;
	message: string;
}

export interface AiImageJobResult {
	jobId: string;
	status: AiImageJobStatus;
	resultAssetId?: string;
	error?: AiImageJobError;
	startedAt: number;
	finishedAt?: number;
}

export interface AiLayerBounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface AiLayerContext {
	artboardId: string;
	selectedNodeId?: string;
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
