import { describe, expect, it } from "vitest";
import {
	createCanvasIR,
	createComponentInstance,
	createGroup,
	createPage,
	createRect,
} from "../ir/builders.js";
import {
	CanvasDocumentBudgetError,
	DEFAULT_CANVAS_DOCUMENT_BUDGET_POLICY,
	validateCanvasDocumentBudget,
} from "../ir/document-budget.js";
import type { CanvasComponentDefinition, CanvasIR } from "../ir/types.js";
import {
	MAX_CHILDREN_PER_CONTAINER,
	MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
	MAX_DOCUMENT_ASSETS,
	MAX_DOCUMENT_BYTES,
	MAX_DOCUMENT_COMPONENTS,
	MAX_DOCUMENT_NODES,
	MAX_DOCUMENT_PAGES,
	MAX_DOCUMENT_STRING_CHARACTERS,
	MAX_TREE_DEPTH,
} from "../limits.js";

function documentWithRoot(root = createGroup({ id: "root" })): CanvasIR {
	return createCanvasIR({
		id: "document",
		title: "Budget fixture",
		pages: [createPage({ id: "page", root })],
		now: () => "2026-08-27T00:00:00.000Z",
	});
}

function component(id: string): CanvasComponentDefinition {
	return {
		id,
		name: id,
		revision: 1,
		root: createGroup({ id: `${id}-root` }),
		properties: [],
	};
}

function issueCodes(
	ir: unknown,
	policy: Parameters<typeof validateCanvasDocumentBudget>[1],
): string[] {
	return validateCanvasDocumentBudget(ir, policy).issues.map(
		(issue) => issue.code,
	);
}

describe("Canvas document budget", () => {
	it("pins every default to the canonical resource-limit module", () => {
		expect(DEFAULT_CANVAS_DOCUMENT_BUDGET_POLICY).toEqual({
			maxUtf8Bytes: MAX_DOCUMENT_BYTES,
			maxPages: MAX_DOCUMENT_PAGES,
			maxNodes: MAX_DOCUMENT_NODES,
			maxTreeDepth: MAX_TREE_DEPTH,
			maxChildrenPerContainer: MAX_CHILDREN_PER_CONTAINER,
			maxAssets: MAX_DOCUMENT_ASSETS,
			maxComponents: MAX_DOCUMENT_COMPONENTS,
			maxStringCharacters: MAX_DOCUMENT_STRING_CHARACTERS,
			maxExpandedComponentNodes: MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
		});
	});

	it("accepts the byte boundary and rejects boundary plus one", () => {
		const ir = documentWithRoot();
		expect(
			validateCanvasDocumentBudget(ir, {
				rawByteLength: 10,
				policy: { maxUtf8Bytes: 10 },
			}).ok,
		).toBe(true);
		expect(
			issueCodes(ir, {
				rawByteLength: 11,
				policy: { maxUtf8Bytes: 10 },
			}),
		).toContain("document-bytes-exceeded");
	});

	it("accepts the page boundary and rejects boundary plus one", () => {
		const one = documentWithRoot();
		const two = { ...one, pages: [...one.pages, createPage({ id: "page-2" })] };
		expect(
			validateCanvasDocumentBudget(one, { policy: { maxPages: 1 } }).ok,
		).toBe(true);
		expect(issueCodes(two, { policy: { maxPages: 1 } })).toContain(
			"document-pages-exceeded",
		);
	});

	it("accepts the node boundary and rejects boundary plus one", () => {
		const one = documentWithRoot();
		const two = documentWithRoot(
			createGroup({
				id: "root",
				children: [createRect({ id: "rect", bounds: { width: 1, height: 1 } })],
			}),
		);
		expect(
			validateCanvasDocumentBudget(one, { policy: { maxNodes: 1 } }).ok,
		).toBe(true);
		expect(issueCodes(two, { policy: { maxNodes: 1 } })).toContain(
			"document-nodes-exceeded",
		);
	});

	it("accepts the depth boundary and rejects boundary plus one", () => {
		const depthZero = documentWithRoot();
		const depthOne = documentWithRoot(
			createGroup({
				id: "root",
				children: [createGroup({ id: "nested" })],
			}),
		);
		expect(
			validateCanvasDocumentBudget(depthZero, {
				policy: { maxTreeDepth: 0 },
			}).ok,
		).toBe(true);
		expect(issueCodes(depthOne, { policy: { maxTreeDepth: 0 } })).toContain(
			"document-depth-exceeded",
		);
	});

	it("accepts the container-width boundary and rejects boundary plus one", () => {
		const empty = documentWithRoot();
		const oneChild = documentWithRoot(
			createGroup({
				id: "root",
				children: [createGroup({ id: "child" })],
			}),
		);
		expect(
			validateCanvasDocumentBudget(empty, {
				policy: { maxChildrenPerContainer: 0 },
			}).ok,
		).toBe(true);
		expect(
			issueCodes(oneChild, { policy: { maxChildrenPerContainer: 0 } }),
		).toContain("document-children-exceeded");
	});

	it("returns stable structured diagnostics with recovery actions", () => {
		const ir = documentWithRoot(
			createGroup({
				id: "root",
				children: [createGroup({ id: "child" })],
			}),
		);
		const result = validateCanvasDocumentBudget(ir, {
			policy: { maxChildrenPerContainer: 0 },
		});
		const issue = result.issues.find(
			(candidate) => candidate.code === "document-children-exceeded",
		);

		expect(issue).toMatchObject({
			code: "document-children-exceeded",
			observed: 1,
			limit: 0,
			path: "$.pages[0].root.children",
			message: expect.stringContaining("Container child count is 1"),
			recoveryActions: [
				{
					code: "split-container",
					label: "Split this container into smaller containers.",
				},
			],
		});

		const error = new CanvasDocumentBudgetError(result);
		expect(error.issues).toBe(result.issues);
		expect(error.metrics).toBe(result.metrics);
		expect(error.message).toContain(issue?.message);
		expect(error.message).toContain("Split this container");
	});

	it("accepts the asset boundary and rejects boundary plus one", () => {
		const one = {
			...documentWithRoot(),
			assets: { a: { id: "a", uri: "asset:a" } },
		};
		const two = {
			...one,
			assets: { ...one.assets, b: { id: "b", uri: "asset:b" } },
		};
		expect(
			validateCanvasDocumentBudget(one, { policy: { maxAssets: 1 } }).ok,
		).toBe(true);
		expect(issueCodes(two, { policy: { maxAssets: 1 } })).toContain(
			"document-assets-exceeded",
		);
	});

	it("accepts the component boundary and rejects boundary plus one", () => {
		const one: CanvasIR = {
			...documentWithRoot(),
			components: { first: component("first") },
		};
		const two: CanvasIR = {
			...one,
			components: { ...one.components, second: component("second") },
		};
		expect(
			validateCanvasDocumentBudget(one, { policy: { maxComponents: 1 } }).ok,
		).toBe(true);
		expect(issueCodes(two, { policy: { maxComponents: 1 } })).toContain(
			"document-components-exceeded",
		);
	});

	it("accepts the aggregate-string boundary and rejects boundary plus one", () => {
		const ir = documentWithRoot();
		const baseline = validateCanvasDocumentBudget(ir).metrics.stringCharacters;
		expect(
			validateCanvasDocumentBudget(ir, {
				policy: { maxStringCharacters: baseline },
			}).ok,
		).toBe(true);
		const plusOne = { ...ir, title: `${ir.title}x` };
		expect(
			issueCodes(plusOne, {
				policy: { maxStringCharacters: baseline },
			}),
		).toContain("document-strings-exceeded");
	});

	it("accepts the expanded-component boundary and rejects boundary plus one", () => {
		const definition = component("card");
		const instance = (id: string) =>
			createComponentInstance({
				id,
				componentId: "card",
				bounds: { width: 1, height: 1 },
			});
		const one: CanvasIR = {
			...documentWithRoot(
				createGroup({ id: "root", children: [instance("instance-1")] }),
			),
			components: { card: definition },
		};
		const two: CanvasIR = {
			...one,
			pages: [
				createPage({
					id: "page",
					root: createGroup({
						id: "root",
						children: [instance("instance-1"), instance("instance-2")],
					}),
				}),
			],
		};
		expect(
			validateCanvasDocumentBudget(one, {
				policy: { maxExpandedComponentNodes: 1 },
			}).ok,
		).toBe(true);
		expect(
			issueCodes(two, { policy: { maxExpandedComponentNodes: 1 } }),
		).toContain("document-expanded-nodes-exceeded");
	});

	it("rejects recursive component definitions without recursive traversal", () => {
		const recursive: CanvasComponentDefinition = {
			...component("recursive"),
			root: createComponentInstance({
				id: "self",
				componentId: "recursive",
				bounds: { width: 1, height: 1 },
			}),
		};
		const ir: CanvasIR = {
			...documentWithRoot(),
			components: { recursive },
		};
		expect(issueCodes(ir, {})).toContain("document-component-cycle");
	});
});
