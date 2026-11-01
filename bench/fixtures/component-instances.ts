/**
 * @file Component-instance counterparts of the M0-03 repeated-structure
 * fixtures (plan 0023 M6-04).
 *
 * The SAME visual content as `repeated-structures.ts` — the PRD §2 marketing
 * card — but expressed as ONE Component Source plus N instances instead of N
 * independent copies. That is what makes the M6-04 comparison meaningful: any
 * difference in the figures is the cost of the component subsystem, not of a
 * different document.
 *
 * Deterministic by construction (fixed ids, fixed clock, grid placement), for
 * the same reason the plain fixtures are: a randomly-shaped fixture makes
 * run-to-run figures incomparable.
 */

import {
	createCanvasIR,
	createComponentInstance,
	createFrame,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../../src/ir/builders.js";
import { insertNode } from "../../src/ir/mutations.js";
import type {
	CanvasComponentDefinition,
	CanvasComponentOverrideMap,
	CanvasIR,
	CanvasNode,
} from "../../src/ir/types.js";

/** Mirrors the plain fixtures' counts so the two records line up row for row. */
export const COMPONENT_INSTANCE_COUNTS = [1, 10, 100, 500] as const;

/** Same card geometry as the plain fixture, so the documents are comparable. */
const CARD_WIDTH = 200;
const CARD_HEIGHT = 160;
const GRID_COLUMNS = 10;

const FIXED_NOW = () => "2026-07-28T00:00:00.000Z";

/** The Property ID the warm-path override edit targets. */
export const CARD_TITLE_PROPERTY = "p-card-title";

/**
 * The card as a Component Source. Node ids are the DEFINITION's, shared by
 * every instance — the instances differ only in placement.
 */
export function cardComponentDefinition(): CanvasComponentDefinition {
	return {
		id: "cmp-card",
		name: "CTA card",
		revision: 1,
		properties: [
			{
				id: CARD_TITLE_PROPERTY,
				name: "Title",
				nodeId: "src-title",
				kind: "text",
				targetKind: "text",
			},
		],
		root: {
			...createFrame({
				id: "src-card",
				name: "CTA card",
				bounds: { width: CARD_WIDTH, height: CARD_HEIGHT },
			}),
			children: [
				createRect({
					id: "src-media",
					bounds: { width: CARD_WIDTH, height: 80 },
				}),
				createText({
					id: "src-title",
					text: "Summer sale",
					transform: { y: 88 },
					bounds: { width: CARD_WIDTH, height: 24 },
				}),
				createText({
					id: "src-body",
					text: "Up to 40% off sitewide, this week only.",
					transform: { y: 116 },
					bounds: { width: CARD_WIDTH, height: 18 },
				}),
				createFrame({
					id: "src-button",
					transform: { y: 138 },
					bounds: { width: 96, height: 20 },
					children: [
						createText({
							id: "src-button-label",
							text: "Shop now",
							bounds: { width: 96, height: 20 },
						}),
					],
				}),
			],
		} as CanvasNode,
	};
}

/**
 * A one-page document holding `count` INSTANCES of the card component, laid out
 * on the same grid the plain fixture uses.
 */
export function buildComponentInstances(count: number): CanvasIR {
	const page = createPage({ id: "repeated-page" });
	page.root = createGroup({ id: "repeated-root", bounds: page.root.bounds });
	let ir = createCanvasIR({
		id: `instances-${count}`,
		title: `instances-${count}`,
		pages: [page],
		now: FIXED_NOW,
	});
	for (let i = 0; i < count; i += 1) {
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: createComponentInstance({
				id: `inst-${i}`,
				componentId: "cmp-card",
				transform: {
					x: (i % GRID_COLUMNS) * (CARD_WIDTH + 20),
					y: Math.floor(i / GRID_COLUMNS) * (CARD_HEIGHT + 20),
				},
				bounds: { width: CARD_WIDTH, height: CARD_HEIGHT },
			}),
			now: FIXED_NOW,
		});
	}
	return { ...ir, components: { "cmp-card": cardComponentDefinition() } };
}

/**
 * The localized warm-path edit: ONE instance gains a title override.
 *
 * The component analogue of `editOneStructure` — and the edit T-PERF-1 is about:
 * it must invalidate that instance (and the ancestors whose layout depends on
 * it) and nothing else.
 */
export function overrideOneInstance(ir: CanvasIR, index = 0): CanvasIR {
	const pages = ir.pages.map((page) => ({
		...page,
		root: {
			...page.root,
			children: page.root.children.map((child) =>
				child.id === `inst-${index}`
					? ({
							...child,
							overrides: {
								[CARD_TITLE_PROPERTY]: {
									kind: "text",
									value: { kind: "plain", text: "Edited title" },
								},
							} satisfies CanvasComponentOverrideMap,
						} as CanvasNode)
					: child,
			),
		} as CanvasNode,
	}));
	return { ...ir, pages: pages as CanvasIR["pages"] };
}

/**
 * The propagating edit: the SOURCE's title changes, so every instance re-renders
 * from one Registry write plus a revision bump — no instance node is touched.
 */
export function editComponentSource(ir: CanvasIR): CanvasIR {
	const definition = ir.components?.["cmp-card"];
	if (!definition) return ir;
	const root = definition.root as CanvasNode & { children: CanvasNode[] };
	return {
		...ir,
		components: {
			"cmp-card": {
				...definition,
				revision: definition.revision + 1,
				root: {
					...root,
					children: root.children.map((child) =>
						child.id === "src-title"
							? ({ ...child, text: "Edited title" } as CanvasNode)
							: child,
					),
				} as CanvasNode,
			},
		},
	};
}
