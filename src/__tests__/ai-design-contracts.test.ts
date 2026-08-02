import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import type {
	CanvasCommand,
	CanvasNodeUpdateCommand,
} from "../commands/types.js";
import {
	createCanvasIR,
	createFrame,
	createGroup,
	createImage,
	createPage,
	createText,
} from "../ir/builders.js";
import { insertNode } from "../ir/mutations.js";
import type {
	CanvasAutoLayout,
	CanvasComponentDefinition,
	CanvasPage,
} from "../ir/types.js";

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

/**
 * C-2's quarantining `default:` only stays correct while the case list above
 * it covers every REAL built-in. It did not: the Auto Layout and Local
 * Components commands were never added, so every AI proposal carrying one was
 * falsely quarantined as "Unrecognized command type" (C-2-R).
 *
 * Parity is asserted by scanning both lists from source — the validator's
 * `case` labels and `BUILTIN_COMMAND_TYPE_FLAGS`'s keys — for the same reason
 * `commands/__tests__/registry-parity.test.ts` scans `applyCommand`'s switch:
 * a TypeScript union erases at compile time, and a `switch` with a `default:`
 * is not exhaustiveness-checked, so a restated array in the test would drift
 * exactly the way the thing it checks drifted. A 38th command type now fails
 * this test instead of silently regressing to a false quarantine.
 */
function readPackageSource(specifier: string): string {
	return readFileSync(
		fileURLToPath(new URL(specifier, import.meta.url)),
		"utf8",
	);
}

function commandTypesClassifiedByValidator(): ReadonlySet<string> {
	const source = readPackageSource("../ai-design-contracts.ts");
	const start = source.indexOf("function collectCommandValidationIssues");
	expect(
		start,
		"collectCommandValidationIssues not found in ai-design-contracts.ts — this scan needs updating",
	).toBeGreaterThan(-1);
	// Bound the scan to the switch's classified cases: everything after the
	// `default:` is the quarantine branch, which classifies nothing.
	const end = source.indexOf("default:", start);
	expect(
		end,
		"the quarantine default: was not found — this scan needs updating",
	).toBeGreaterThan(start);

	const types = new Set<string>();
	for (const match of source.slice(start, end).matchAll(/case\s+"([^"]+)":/g)) {
		const type = match[1];
		if (type !== undefined) types.add(type);
	}
	return types;
}

function builtinCommandTypes(): ReadonlySet<string> {
	const source = readPackageSource("../extensions/canvas-runtime.ts");
	const start = source.indexOf("const BUILTIN_COMMAND_TYPE_FLAGS");
	expect(
		start,
		"BUILTIN_COMMAND_TYPE_FLAGS not found in extensions/canvas-runtime.ts — this scan needs updating",
	).toBeGreaterThan(-1);
	const end = source.indexOf("\n};", start);
	expect(
		end,
		"BUILTIN_COMMAND_TYPE_FLAGS's closing brace was not found — this scan needs updating",
	).toBeGreaterThan(start);

	const types = new Set<string>();
	for (const match of source
		.slice(start, end)
		.matchAll(/(?:"([^"]+)"|([A-Za-z][\w-]*)):\s*true/g)) {
		const type = match[1] ?? match[2];
		if (type !== undefined) types.add(type);
	}
	return types;
}

function componentDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-card",
		name: "Card",
		revision: 1,
		properties: [],
		root: createFrame({
			id: "cmp-card-root",
			bounds: { width: 200, height: 120 },
			children: [
				createText({
					id: "cmp-card-title",
					bounds: { width: 200, height: 40 },
					text: "Title",
				}),
			],
		}),
	};
}

const AUTO_LAYOUT: CanvasAutoLayout = {
	version: 1,
	direction: "vertical",
	padding: { top: 8, right: 8, bottom: 8, left: 8 },
	gap: 12,
	primaryAlign: "start",
	crossAlign: "center",
};

function validateCommand(command: CanvasCommand) {
	return validateAiDesignJobResult({
		jobId: "j1",
		status: "complete",
		payload: { kind: "command", command },
		startedAt: 0,
	});
}

describe("collectCommandValidationIssues — built-in command coverage (C-2-R)", () => {
	it("finds both lists", () => {
		// Guards the guards: a scan that silently matched nothing would make the
		// parity assertion below vacuous.
		expect(commandTypesClassifiedByValidator().size).toBeGreaterThan(20);
		expect(builtinCommandTypes().size).toBeGreaterThan(20);
	});

	it("classifies every built-in command type rather than quarantining it", () => {
		const classified = commandTypesClassifiedByValidator();
		const builtins = builtinCommandTypes();
		expect(
			[...builtins].filter((type) => !classified.has(type)).sort(),
			"built-in command types that fall through to the quarantining default:",
		).toEqual([]);
		expect(
			[...classified].filter((type) => !builtins.has(type)).sort(),
			"command types the validator classifies that are not built-ins",
		).toEqual([]);
	});

	it("does not quarantine a frame.set-layout proposal", () => {
		const outcome = validateCommand({
			type: "frame.set-layout",
			nodeId: "frame-1",
			layout: AUTO_LAYOUT,
			geometry: [
				{
					nodeId: "headline",
					transform: { x: 8, y: 8, rotation: 0, scaleX: 1, scaleY: 1 },
					bounds: { width: 184, height: 40 },
				},
			],
		});
		expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
	});

	it("does not quarantine a component.create proposal", () => {
		const outcome = validateCommand({
			type: "component.create",
			mode: "restore",
			definition: componentDefinition(),
		});
		expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
	});

	it("does not quarantine a component-instance.insert carrying a partial transform", () => {
		const outcome = validateCommand({
			type: "component-instance.insert",
			componentId: "cmp-card",
			instanceId: "inst-1",
			pageId: "p1",
			bounds: { width: 200, height: 120 },
			transform: { x: 24 },
		});
		expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
	});

	it("still schema-checks the Source tree a component.create embeds", () => {
		const definition = componentDefinition();
		const outcome = validateCommand({
			type: "component.create",
			mode: "restore",
			definition: {
				...definition,
				root: {
					...definition.root,
					transform: {
						x: Number.NaN,
						y: 0,
						rotation: 0,
						scaleX: 1,
						scaleY: 1,
					},
				},
			},
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected quarantine");
		expect(outcome.error.code).toBe("invalid-payload");
		expect(outcome.error.issues?.length).toBeGreaterThan(0);
	});

	it("still schema-checks the geometry a frame.set-layout writes", () => {
		const outcome = validateCommand({
			type: "frame.set-layout",
			nodeId: "frame-1",
			layout: { ...AUTO_LAYOUT, gap: Number.NaN },
		});
		expect(outcome.ok).toBe(false);
		if (outcome.ok) throw new Error("expected quarantine");
		expect(outcome.error.code).toBe("invalid-payload");
		expect(outcome.error.issues?.length).toBeGreaterThan(0);
	});
});
