/**
 * @file Repeated-structure fixtures for the plan 0023 M0-03 pre-component
 * baseline.
 *
 * Each "structure" is the marketing-card shape PRD 0015 §2 describes (CTA
 * card: media placeholder, title, body, button) built from PLAIN nodes —
 * deliberately no component concept, because these fixtures record what
 * resolving N independent copies costs TODAY. The M2 component resolver is
 * measured against these exact documents: same visual content, instances
 * instead of copies.
 *
 * Deterministic by construction (fixed ids, grid placement, no randomness):
 * a randomly-shaped fixture would make run-to-run figures incomparable.
 */

import {
	createCanvasIR,
	createFrame,
	createGroup,
	createPage,
	createRect,
	createText,
} from "../../src/ir/builders.js";
import { insertNode, updateNode } from "../../src/ir/mutations.js";
import type { CanvasIR } from "../../src/ir/types.js";

/** The instance counts NFR-001 is quoted over (100 is the p95 ≤ 100 ms one). */
export const REPEATED_STRUCTURE_COUNTS = [1, 10, 100, 500] as const;

/**
 * Nodes per card: card frame + media rect + title text + body text +
 * button frame + button label text.
 */
export const NODES_PER_STRUCTURE = 6;

const CARD_WIDTH = 200;
const CARD_HEIGHT = 160;
const GRID_COLUMNS = 10;

/** Pinned clock — see `buildRepeatedStructures`. */
const FIXED_NOW = () => "2026-07-28T00:00:00.000Z";

/** One CTA-card subtree. Ids are stable and derived from the card index. */
function buildCard(index: number) {
	return createFrame({
		id: `card-${index}`,
		name: `CTA card ${index}`,
		transform: {
			x: (index % GRID_COLUMNS) * (CARD_WIDTH + 20),
			y: Math.floor(index / GRID_COLUMNS) * (CARD_HEIGHT + 20),
		},
		bounds: { width: CARD_WIDTH, height: CARD_HEIGHT },
		children: [
			createRect({
				id: `card-${index}-media`,
				bounds: { width: CARD_WIDTH, height: 80 },
			}),
			createText({
				id: `card-${index}-title`,
				text: `Summer sale ${index}`,
				transform: { y: 88 },
				bounds: { width: CARD_WIDTH, height: 24 },
			}),
			createText({
				id: `card-${index}-body`,
				text: "Up to 40% off sitewide, this week only.",
				transform: { y: 116 },
				bounds: { width: CARD_WIDTH, height: 18 },
			}),
			createFrame({
				id: `card-${index}-button`,
				transform: { y: 138 },
				bounds: { width: 96, height: 20 },
				children: [
					createText({
						id: `card-${index}-button-label`,
						text: "Shop now",
						bounds: { width: 96, height: 20 },
					}),
				],
			}),
		],
	});
}

/**
 * A one-page document holding `count` independent copies of the card —
 * the pre-component shape of "the same structure, repeated".
 */
export function buildRepeatedStructures(count: number): CanvasIR {
	const page = createPage({ id: "repeated-page" });
	// Fixed root id and clock: every generated id and timestamp is pinned so
	// two builds of the same count are byte-identical (the self-test relies
	// on it, and nondeterministic fixtures make figures incomparable).
	page.root = createGroup({ id: "repeated-root", bounds: page.root.bounds });
	let ir = createCanvasIR({
		id: `repeated-${count}`,
		title: `repeated-${count}`,
		pages: [page],
		now: FIXED_NOW,
	});
	for (let i = 0; i < count; i += 1) {
		ir = insertNode(ir, {
			parentId: page.root.id,
			node: buildCard(i),
			now: FIXED_NOW,
		});
	}
	return ir;
}

/**
 * The localized edit whose re-resolution the warm figure measures (one
 * card's title changes — the propagation shape a component Source edit
 * will have in M2).
 */
export function editOneStructure(ir: CanvasIR, index = 0): CanvasIR {
	return updateNode(ir, {
		id: `card-${index}-title`,
		patch: { text: "Edited title" },
		now: FIXED_NOW,
	});
}
