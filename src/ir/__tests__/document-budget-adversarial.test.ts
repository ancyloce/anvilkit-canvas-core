import { describe, expect, it } from "vitest";
import {
	MAX_CHILDREN_PER_CONTAINER,
	MAX_DOCUMENT_ASSETS,
	MAX_DOCUMENT_PAGES,
	MAX_DOCUMENT_STRING_CHARACTERS,
	MAX_TREE_DEPTH,
} from "../../limits.js";
import { validateCanvasDocumentBudget } from "../document-budget.js";
import type { CanvasGroupNode } from "../types.js";
import {
	createDeepTreeDocument,
	createLargeStringDocument,
	createManyAssetsDocument,
	createManyPagesDocument,
	createRecursiveComponentDocument,
	createWideContainerDocument,
} from "./fixtures/document-budget-adversarial.js";

function issueCodes(value: unknown): string[] {
	return validateCanvasDocumentBudget(value).issues.map((issue) => issue.code);
}

describe("adversarial document-budget fixtures", () => {
	it("accepts the default depth boundary and rejects boundary plus one", () => {
		expect(
			validateCanvasDocumentBudget(createDeepTreeDocument(MAX_TREE_DEPTH)).ok,
		).toBe(true);
		expect(issueCodes(createDeepTreeDocument(MAX_TREE_DEPTH + 1))).toContain(
			"document-depth-exceeded",
		);
	});

	it("rejects a tree thousands of levels deep without recursive traversal", () => {
		const result = validateCanvasDocumentBudget(createDeepTreeDocument(5_000));
		expect(result.ok).toBe(false);
		expect(result.issues.map((issue) => issue.code)).toContain(
			"document-depth-exceeded",
		);
		expect(result.metrics.maxTreeDepth).toBe(MAX_TREE_DEPTH + 1);
	});

	it("accepts the default width boundary and rejects boundary plus one", () => {
		expect(
			validateCanvasDocumentBudget(
				createWideContainerDocument(MAX_CHILDREN_PER_CONTAINER),
			).ok,
		).toBe(true);
		expect(
			issueCodes(createWideContainerDocument(MAX_CHILDREN_PER_CONTAINER + 1)),
		).toContain("document-children-exceeded");
	});

	it("visits wide input in direct proportion to its size", () => {
		const instrument = (childCount: number) => {
			const document = createWideContainerDocument(childCount);
			const root = document.pages[0]?.root as CanvasGroupNode;
			let idReads = 0;
			for (const [index, child] of root.children.entries()) {
				Object.defineProperty(child, "id", {
					configurable: true,
					enumerable: true,
					get: () => {
						idReads += 1;
						return `observed-${index}`;
					},
				});
			}
			return { document, idReads: () => idReads };
		};
		const small = instrument(100);
		const large = instrument(200);

		validateCanvasDocumentBudget(small.document);
		validateCanvasDocumentBudget(large.document);

		expect(small.idReads()).toBe(100);
		expect(large.idReads()).toBe(200);
	});

	it("accepts the default aggregate-string boundary and rejects plus one", () => {
		const baseline = validateCanvasDocumentBudget(createLargeStringDocument(0))
			.metrics.stringCharacters;
		const titleCapacity = MAX_DOCUMENT_STRING_CHARACTERS - baseline;

		expect(
			validateCanvasDocumentBudget(createLargeStringDocument(titleCapacity)).ok,
		).toBe(true);
		expect(issueCodes(createLargeStringDocument(titleCapacity + 1))).toContain(
			"document-strings-exceeded",
		);
	});

	it("rejects recursive component definitions with actionable diagnostics", () => {
		const result = validateCanvasDocumentBudget(
			createRecursiveComponentDocument(),
		);
		const issue = result.issues.find(
			(candidate) => candidate.code === "document-component-cycle",
		);
		expect(issue?.path).toBe("$.components.recursive.root");
		expect(issue?.recoveryActions[0]?.code).toBe("break-component-cycle");
	});

	it("accepts the default page boundary and rejects boundary plus one", () => {
		expect(
			validateCanvasDocumentBudget(createManyPagesDocument(MAX_DOCUMENT_PAGES))
				.ok,
		).toBe(true);
		expect(
			issueCodes(createManyPagesDocument(MAX_DOCUMENT_PAGES + 1)),
		).toContain("document-pages-exceeded");
	});

	it("accepts the default asset boundary and rejects boundary plus one", () => {
		expect(
			validateCanvasDocumentBudget(
				createManyAssetsDocument(MAX_DOCUMENT_ASSETS),
			).ok,
		).toBe(true);
		expect(
			issueCodes(createManyAssetsDocument(MAX_DOCUMENT_ASSETS + 1)),
		).toContain("document-assets-exceeded");
	});
});
