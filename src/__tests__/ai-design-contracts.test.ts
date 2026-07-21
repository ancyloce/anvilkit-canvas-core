import { describe, expect, it } from "vitest";
import {
	type AiApplyBrandRequest,
	type AiDesignJobRequest,
	type AiDesignJobResult,
	type AiDesignProvider,
	type AiGenerateLayoutVariantsRequest,
	type AiProviderCapabilities,
	type AiResizeCampaignRequest,
	type AiRewriteCopyRequest,
	validateAiDesignJobResult,
} from "../ai-design-contracts.js";
import { applyCommand } from "../commands/runtime.js";
import type { CanvasNodeUpdateCommand } from "../commands/types.js";
import {
	createCanvasIR,
	createGroup,
	createImage,
	createPage,
	createText,
} from "../ir/builders.js";
import { insertNode } from "../ir/mutations.js";
import type { CanvasPage } from "../ir/types.js";

function makeDocument() {
	const page = createPage({ id: "p1" });
	let ir = createCanvasIR({
		id: "doc1",
		pages: [page],
		now: () => "2026-07-13T00:00:00.000Z",
	});
	ir = insertNode(ir, {
		parentId: page.root.id,
		node: createText({
			id: "headline",
			bounds: { width: 200, height: 40 },
			text: "Original headline",
		}),
	});
	return ir;
}

describe("AiDesignJobRequest — FR-050 design-level ops", () => {
	it("rewrite-copy targets a node by id with an optional instruction", () => {
		const request: AiRewriteCopyRequest = {
			kind: "rewrite-copy",
			nodeId: "headline",
			instruction: "make it punchier",
		};
		const asUnion: AiDesignJobRequest = request;
		expect(asUnion.kind).toBe("rewrite-copy");
	});

	it("apply-brand carries a full BrandKitDefinition, not just an id", () => {
		const request: AiApplyBrandRequest = {
			kind: "apply-brand",
			brandKit: {
				id: "brand1",
				name: "Acme",
				logos: [],
				colors: [],
				fonts: [],
				typography: [],
				rules: [],
			},
		};
		expect(request.brandKit.name).toBe("Acme");
	});

	it("resize-campaign references preset ids, not full preset objects", () => {
		const request: AiResizeCampaignRequest = {
			kind: "resize-campaign",
			sourcePageId: "p1",
			presetIds: ["instagram-post", "youtube-thumbnail"],
		};
		expect(request.presetIds).toHaveLength(2);
	});

	it("generate-layout-variants is optional-count, defaulting to the provider's choice", () => {
		const request: AiGenerateLayoutVariantsRequest = {
			kind: "generate-layout-variants",
			sourcePageId: "p1",
		};
		expect(request.count).toBeUndefined();
	});
});

describe("AiDesignJobResult — FR-050 failed-job invariant", () => {
	it("a complete result carries a payload and no error field", () => {
		const result: AiDesignJobResult = {
			jobId: "j1",
			status: "complete",
			payload: {
				kind: "command",
				command: {
					type: "node.update",
					nodeId: "headline",
					kind: "text",
					patch: { text: "Rewritten" },
				},
			},
			startedAt: 0,
		};
		expect("error" in result).toBe(false);
	});

	it("an error result carries no payload field — compile-time proof", () => {
		const result: AiDesignJobResult = {
			jobId: "j1",
			status: "error",
			error: { code: "PROVIDER_TIMEOUT", message: "timed out" },
			startedAt: 0,
			finishedAt: 5,
		};
		expect("payload" in result).toBe(false);
	});

	it("a cancelled result carries no payload field", () => {
		const result: AiDesignJobResult = {
			jobId: "j1",
			status: "cancelled",
			startedAt: 0,
		};
		expect("payload" in result).toBe(false);
	});
});

describe("AiDesignJobResult — reversibility (applying then undoing restores prior state)", () => {
	it("a rewrite-copy result's command applies and undoes cleanly", () => {
		const document = makeDocument();

		const result: AiDesignJobResult = {
			jobId: "job-rewrite",
			status: "complete",
			payload: {
				kind: "command",
				command: {
					type: "node.update",
					nodeId: "headline",
					kind: "text",
					patch: { text: "Rewritten by AI" },
				} satisfies CanvasNodeUpdateCommand<"text">,
			},
			startedAt: 0,
		};
		if (result.status !== "complete" || result.payload.kind !== "command") {
			throw new Error("expected a complete command result");
		}

		const applied = applyCommand(document, result.payload.command);
		expect(
			applied.ir.pages[0]?.root.children.find((n) => n.id === "headline"),
		).toMatchObject({ text: "Rewritten by AI" });

		const undone = applyCommand(applied.ir, applied.inverse);
		// `metadata.updatedAt` legitimately advances on every apply (real clock,
		// not injected) — compare everything else, which is what "restores
		// prior state" actually means for the document's content.
		expect({ ...undone.ir, metadata: undefined }).toEqual({
			...document,
			metadata: undefined,
		});
	});
});

describe("AiProviderCapabilities — FR-051 capability discovery", () => {
	it("omitting a list means unknown/assume-everything, not empty", () => {
		const unknown: AiProviderCapabilities = {};
		expect(unknown.imageOps).toBeUndefined();
		expect(unknown.designOps).toBeUndefined();
	});

	it("lists exactly the ops a provider declares support for", () => {
		const capabilities: AiProviderCapabilities = {
			imageOps: ["text-to-image", "bg-remove"],
			designOps: ["rewrite-copy", "apply-brand"],
		};
		expect(capabilities.imageOps).toContain("bg-remove");
		expect(capabilities.designOps).not.toContain("resize-campaign");
	});

	it("AiDesignProvider is a bare function, not an object interface — compile-time proof", async () => {
		const provider: AiDesignProvider = async (request) => ({
			jobId: "j1",
			status: "complete",
			payload: { kind: "command", command: { type: "batch", commands: [] } },
			startedAt: 0,
			// Touch `request` so the param isn't flagged unused; a real
			// provider would branch on `request.kind` here.
			finishedAt: request ? 1 : 0,
		});
		expect(typeof provider).toBe("function");
	});
});

function validPage(id: string): CanvasPage {
	return createPage({
		id,
		root: createGroup({
			children: [
				createText({
					id: `${id}-text`,
					bounds: { width: 200, height: 40 },
					text: "AI-generated headline",
				}),
				createImage({
					id: `${id}-image`,
					bounds: { width: 100, height: 100 },
					assetId: "asset-from-ai",
				}),
			],
		}),
	});
}

describe("validateAiDesignJobResult — FR-052 validation/quarantine layer", () => {
	it("quarantines a non-complete job without inspecting any payload", () => {
		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "error",
			error: { code: "PROVIDER_TIMEOUT", message: "timed out" },
			startedAt: 0,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected quarantine");
		expect(outcome.error.code).toBe("job-not-complete");
	});

	it("quarantines a pending job the same way", () => {
		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "pending",
			startedAt: 0,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected quarantine");
		expect(outcome.error.code).toBe("job-not-complete");
	});

	it("validates and normalizes a command payload into a one-command batch", () => {
		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "complete",
			payload: {
				kind: "command",
				command: {
					type: "node.update",
					nodeId: "headline",
					kind: "text",
					patch: { text: "Rewritten" },
				},
			},
			startedAt: 0,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("expected success");
		expect(outcome.command.type).toBe("batch");
		expect(outcome.command.commands).toHaveLength(1);
	});

	it("validates a well-formed pages payload — AI images are real image asset nodes, text stays a normal text node", () => {
		const pages = [validPage("variant-1"), validPage("variant-2")];
		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "complete",
			payload: { kind: "pages", pages },
			startedAt: 0,
		});
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error("expected success");
		expect(outcome.command.commands).toHaveLength(2);
		for (const cmd of outcome.command.commands) {
			if (cmd.type !== "page.create") throw new Error("expected page.create");
			const [textNode, imageNode] = cmd.page.root.children;
			// The image is a real asset-reference node (assetId), never inline
			// pixel data or a whole-page-screenshot stand-in.
			expect(imageNode?.type).toBe("image");
			expect(
				imageNode && "assetId" in imageNode ? imageNode.assetId : null,
			).toBe("asset-from-ai");
			// The text is a normal, fully-editable text node — no read-only /
			// "ai-generated" flag exists on the node shape at all.
			expect(textNode?.type).toBe("text");
			expect(Object.keys(textNode ?? {})).not.toContain("readOnly");
			expect(Object.keys(textNode ?? {})).not.toContain("aiGenerated");
		}
	});

	it("quarantines a page containing a structurally invalid node, with issue details", () => {
		const badPage = validPage("bad-variant");
		// Simulate a hallucinated node: an image node missing its required assetId.
		const [, imageNode] = badPage.root.children;
		if (imageNode && "assetId" in imageNode) {
			// biome-ignore lint/suspicious/noExplicitAny: deliberately corrupting a valid fixture to prove quarantine
			delete (imageNode as any).assetId;
		}

		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "complete",
			payload: { kind: "pages", pages: [badPage] },
			startedAt: 0,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected quarantine");
		expect(outcome.error.code).toBe("invalid-payload");
		expect(outcome.error.issues?.length).toBeGreaterThan(0);
	});

	it("quarantines an unknown node kind nested inside a batch command", () => {
		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "complete",
			payload: {
				kind: "command",
				command: {
					type: "batch",
					commands: [
						{
							type: "node.create",
							parentId: "root",
							node: {
								id: "hallucinated",
								// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid node kind to prove quarantine
								type: "made-up-kind" as any,
								transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
								bounds: { width: 10, height: 10 },
								zIndex: 0,
							},
						},
					],
				},
			},
			startedAt: 0,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected quarantine");
		expect(outcome.error.code).toBe("invalid-payload");
	});

	it("a validated pages payload applies cleanly and each variant is a normal, selectable page", () => {
		const document = makeDocument();
		const pages = [validPage("variant-1")];
		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "complete",
			payload: { kind: "pages", pages },
			startedAt: 0,
		});
		if (!outcome.ok) throw new Error("expected success");

		const { ir } = applyCommand(document, outcome.command);
		expect(ir.pages.map((p) => p.id)).toEqual(["p1", "variant-1"]);
		// Round-tripped through the exact same page.create path every other
		// page-generating feature uses (resizeToVariants, instantiateTemplate)
		// — no bespoke "AI page" kind or viewer required.
		const variant = ir.pages.find((p) => p.id === "variant-1");
		expect(variant?.root.children).toHaveLength(2);
	});

	it("quarantines an unrecognized top-level command type instead of passing it through (C-2)", () => {
		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "complete",
			payload: {
				kind: "command",
				command: {
					// biome-ignore lint/suspicious/noExplicitAny: deliberately hallucinated command type to prove quarantine
					type: "node.teleport" as any,
					nodeId: "headline",
				},
			},
			startedAt: 0,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected quarantine");
		expect(outcome.error.code).toBe("invalid-payload");
	});

	it("quarantines a node.update patch carrying a non-finite transform (C-2)", () => {
		const outcome = validateAiDesignJobResult({
			jobId: "j1",
			status: "complete",
			payload: {
				kind: "command",
				command: {
					type: "node.update",
					nodeId: "headline",
					kind: "text",
					patch: {
						transform: {
							x: Number.NaN,
							y: 0,
							rotation: 0,
							scaleX: 1,
							scaleY: 1,
						},
					},
				} satisfies CanvasNodeUpdateCommand<"text">,
			},
			startedAt: 0,
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected quarantine");
		expect(outcome.error.code).toBe("invalid-payload");
		expect(outcome.error.issues?.length).toBeGreaterThan(0);
	});
});

describe("applyCommand — rejects unrecognized command types (P1 C-2)", () => {
	it("throws unknown-command instead of returning undefined", () => {
		const document = makeDocument();
		expect(() =>
			applyCommand(document, {
				// biome-ignore lint/suspicious/noExplicitAny: deliberately hallucinated command type
				type: "node.teleport" as any,
				nodeId: "headline",
			}),
		).toThrowError(/Unrecognized command type/);
	});
});
