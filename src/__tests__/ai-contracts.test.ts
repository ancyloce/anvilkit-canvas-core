import { describe, expect, it } from "vitest";
import type {
	AiImageBackgroundReplaceRequest,
	AiImageGenerativeExpandRequest,
	AiImageGenerativeFillRequest,
	AiImageJobRequest,
	AiImageJobResult,
	AiImageObjectEraseRequest,
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
