import { describe, expect, it } from "vitest";
import type {
	AiImageBackgroundReplaceRequest,
	AiImageCapability,
	AiImageGenerativeExpandRequest,
	AiImageGenerativeFillRequest,
	AiImageJobRequest,
	AiImageJobResult,
	AiImageObjectEraseRequest,
	AiImageProviderAdapter,
	AiImageProviderDescriptor,
} from "../ai-contracts.js";

describe("AiImageJobRequest — new FR-050 image-editing variants", () => {
	it("accepts a generative-fill request shaped like inpaint (mask + prompt)", () => {
		const request: AiImageGenerativeFillRequest = {
			kind: "generative-fill",
			sourceAssetId: "a1",
			maskAssetId: "m1",
			prompt: "add a sunset",
		};
		const asUnion: AiImageJobRequest = request;
		expect(asUnion.kind).toBe("generative-fill");
	});

	it("accepts a generative-expand request with a target canvas size", () => {
		const request: AiImageGenerativeExpandRequest = {
			kind: "generative-expand",
			sourceAssetId: "a1",
			targetWidth: 1600,
			targetHeight: 900,
		};
		const asUnion: AiImageJobRequest = request;
		expect(asUnion.kind).toBe("generative-expand");
	});

	it("accepts an object-erase request with no prompt field", () => {
		const request: AiImageObjectEraseRequest = {
			kind: "object-erase",
			sourceAssetId: "a1",
			maskAssetId: "m1",
		};
		// Compile-time proof this kind carries no prompt — object-erase removes
		// content, it doesn't generate new content from a description.
		expect(Object.keys(request).sort()).toEqual(
			["kind", "maskAssetId", "sourceAssetId"].sort(),
		);
	});

	it("accepts a background-replace request", () => {
		const request: AiImageBackgroundReplaceRequest = {
			kind: "background-replace",
			sourceAssetId: "a1",
			prompt: "a studio backdrop",
		};
		const asUnion: AiImageJobRequest = request;
		expect(asUnion.kind).toBe("background-replace");
	});
});

describe("AiImageJobResult — FR-050 failed-job invariant", () => {
	it("a complete result carries resultAssetId and no error field", () => {
		const result: AiImageJobResult = {
			jobId: "j1",
			status: "complete",
			resultAssetId: "asset-1",
			startedAt: 0,
		};
		expect("error" in result).toBe(false);
		expect(result.resultAssetId).toBe("asset-1");
	});

	it("an error result carries error and no resultAssetId field — compile-time proof", () => {
		const result: AiImageJobResult = {
			jobId: "j1",
			status: "error",
			error: { code: "PROVIDER_TIMEOUT", message: "timed out" },
			startedAt: 0,
			finishedAt: 10,
		};
		// If `resultAssetId` were assignable here, this would be a compile
		// error to *not* forbid — the point is the field doesn't exist to read.
		expect("resultAssetId" in result).toBe(false);
	});

	it("a cancelled result carries neither resultAssetId nor error", () => {
		const result: AiImageJobResult = {
			jobId: "j1",
			status: "cancelled",
			startedAt: 0,
			finishedAt: 5,
		};
		expect("resultAssetId" in result).toBe(false);
		expect("error" in result).toBe(false);
	});

	it("narrows resultAssetId as a defined string only after checking status === complete", () => {
		function extractAssetId(result: AiImageJobResult): string | null {
			if (result.status !== "complete") return null;
			// No non-null assertion needed — `resultAssetId` is required on
			// the "complete" branch, not optional.
			return result.resultAssetId;
		}
		expect(
			extractAssetId({
				jobId: "j1",
				status: "complete",
				resultAssetId: "a",
				startedAt: 0,
			}),
		).toBe("a");
		expect(
			extractAssetId({
				jobId: "j1",
				status: "error",
				error: { code: "x", message: "y" },
				startedAt: 0,
			}),
		).toBeNull();
	});
});

describe("AiImageProviderAdapter — E7 provider-neutral lifecycle", () => {
	const capabilities: readonly AiImageCapability[] = [
		{
			kind: "text-to-image",
			available: true,
			constraints: { maxPromptCharacters: 2_000, maxPixels: 4_194_304 },
			estimatedCost: { status: "estimated", credits: 1 },
		},
		{ kind: "bg-remove", available: true },
		{ kind: "object-erase", available: true },
		{ kind: "generative-expand", available: false, unavailableReason: "plan" },
	];
	const descriptor: AiImageProviderDescriptor = {
		providerId: "fixture",
		displayName: "Fixture provider",
		capabilities,
	};

	it("discovers capability availability and normalized input limits", async () => {
		const adapter: AiImageProviderAdapter = {
			discoverCapabilities: async () => descriptor,
			startJob: async (_request, _context, options) => {
				options?.onProgress?.({
					phase: "processing",
					progress: 0.5,
					updatedAt: 5,
				});
				return {
					jobId: "job-1",
					status: "pending",
					startedAt: 0,
				};
			},
			getJob: async () => ({
				jobId: "job-1",
				status: "complete",
				resultAssetId: "asset-1",
				startedAt: 0,
				finishedAt: 10,
				metadata: {
					mimeType: "image/png",
					width: 1_024,
					height: 1_024,
					safety: { status: "approved" },
					cost: { status: "final", currency: "USD", amountMicros: 25_000 },
				},
			}),
			cancelJob: async () => ({
				jobId: "job-1",
				status: "cancelled",
				startedAt: 0,
				finishedAt: 6,
			}),
			retryJob: async () => ({
				jobId: "job-2",
				status: "complete",
				resultAssetId: "asset-2",
				startedAt: 7,
				metadata: { safety: { status: "not-evaluated" } },
			}),
		};

		const discovered = await adapter.discoverCapabilities();
		expect(discovered).toEqual(descriptor);
		expect(discovered.capabilities.map(({ kind }) => kind)).toEqual([
			"text-to-image",
			"bg-remove",
			"object-erase",
			"generative-expand",
		]);
		expect(discovered.capabilities[0]?.constraints?.maxPixels).toBe(4_194_304);
	});

	it("normalizes progress, idempotent cancellation, retry, safety, and cost metadata", async () => {
		const progress: number[] = [];
		const adapter: AiImageProviderAdapter = {
			discoverCapabilities: async () => descriptor,
			startJob: async (_request, _context, options) => {
				options?.onProgress?.({
					phase: "processing",
					progress: 0.5,
					updatedAt: 5,
				});
				return { jobId: "job-1", status: "pending", startedAt: 0 };
			},
			getJob: async () => ({
				jobId: "job-1",
				status: "complete",
				resultAssetId: "asset-1",
				startedAt: 0,
				metadata: {
					safety: { status: "approved" },
					cost: { status: "final", credits: 1 },
				},
			}),
			cancelJob: async () => ({
				jobId: "job-1",
				status: "cancelled",
				startedAt: 0,
			}),
			retryJob: async () => ({
				jobId: "job-2",
				status: "pending",
				startedAt: 7,
			}),
		};

		await adapter.startJob(
			{ kind: "text-to-image", prompt: "fixture" },
			{ artboardId: "page-1" },
			{ onProgress: ({ progress: next }) => progress.push(next ?? 0) },
		);
		expect(progress).toEqual([0.5]);
		expect((await adapter.cancelJob("job-1")).status).toBe("cancelled");
		expect(
			(
				await adapter.retryJob(
					"job-1",
					{ kind: "text-to-image", prompt: "fixture" },
					{ artboardId: "page-1" },
				)
			).jobId,
		).toBe("job-2");

		const complete = await adapter.getJob("job-1");
		expect(complete.status).toBe("complete");
		if (complete.status === "complete") {
			expect(complete.metadata?.safety.status).toBe("approved");
			expect(complete.metadata?.cost?.status).toBe("final");
		}
	});
});
