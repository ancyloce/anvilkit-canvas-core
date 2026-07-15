import { nowIso } from "../clock.js";
import type {
	CanvasBatchCommand,
	CanvasPageCreateCommand,
} from "../commands/types.js";
import { regenerateNodeIds } from "../ir/regenerate-ids.js";
import type { CanvasIR, CanvasNode } from "../ir/types.js";
import { CanvasIRSchema } from "../ir/validators.js";
import { walk } from "../ir/walkers.js";
import { resolveTemplateVariables } from "./resolvers.js";
import type { CanvasTemplateDefinition, TemplateSlot } from "./types.js";

function defaultIdFactory(): string {
	return crypto.randomUUID();
}

export interface InstantiateTemplateOptions {
	/** Values keyed by `TemplateVariable.id`. Missing entries fall back to `defaultValue`, per `resolveTemplateVariables`. */
	variables?: Readonly<Record<string, string>>;
	/** Injectable ID factory — call it once per fresh id needed. Defaults to `crypto.randomUUID`. */
	idFactory?: () => string;
	/** Injectable clock, matching the rest of core's factory-injection convention. */
	nowFactory?: () => string;
}

export type InstantiateTemplateWarningCode =
	| "required-variable-missing"
	| "variable-slot-not-found"
	| "slot-node-not-found"
	| "unsupported-slot-mutation";

export interface InstantiateTemplateWarning {
	code: InstantiateTemplateWarningCode;
	variableId?: string;
	slotId?: string;
	nodeId?: string;
}

export interface InstantiateTemplateResult {
	/** A brand-new, fully valid CanvasIR: fresh ids throughout, `documentKind: "template-instance"`. */
	document: CanvasIR;
	/** One `page.create` per page in `document`, as a single batch — apply via `applyCommand`/`applyCommands` for one reversible undo step. */
	command: CanvasBatchCommand;
	warnings: InstantiateTemplateWarning[];
}

/** Node kinds that carry a `fill` (and, except `text`, a `stroke`). */
const FILL_STROKE_KINDS = new Set<CanvasNode["type"]>([
	"rect",
	"ellipse",
	"polygon",
	"star",
	"path",
]);

type AppliedStatus = "applied" | "unsupported";

/**
 * Applies one resolved variable value to its slot's target node, dispatched by
 * the node's own kind first (so each branch narrows to a concrete node type
 * with no casts) and then by what the slot asks for. Locked-node exclusion
 * happens in the caller, before this is ever reached.
 */
function applySlotValue(
	node: CanvasNode,
	slot: TemplateSlot,
	value: string,
): AppliedStatus {
	switch (node.type) {
		case "text":
			if (slot.kind === "text") {
				node.text = value;
				return "applied";
			}
			if (slot.kind === "font") {
				node.fontFamily = value;
				return "applied";
			}
			if (slot.kind === "color" && (slot.property ?? "fill") === "fill") {
				node.fill = value;
				return "applied";
			}
			// CanvasTextNode has no `stroke` field — a color slot with
			// property: "stroke" targeting a text node is unsupported.
			return "unsupported";
		case "rich-text":
			if (slot.kind === "text") {
				for (const paragraph of node.paragraphs) {
					for (const span of paragraph.spans) span.text = value;
				}
				return "applied";
			}
			if (slot.kind === "font") {
				for (const paragraph of node.paragraphs) {
					for (const span of paragraph.spans) span.fontFamily = value;
				}
				return "applied";
			}
			if (slot.kind === "color" && (slot.property ?? "fill") === "fill") {
				for (const paragraph of node.paragraphs) {
					for (const span of paragraph.spans) span.fill = value;
				}
				return "applied";
			}
			return "unsupported";
		case "image":
			if (slot.kind === "image" || slot.kind === "logo") {
				node.assetId = value;
				return "applied";
			}
			return "unsupported";
		case "frame":
			if ((slot.kind === "image" || slot.kind === "logo") && node.placeholder) {
				node.placeholder = { ...node.placeholder, assetId: value };
				return "applied";
			}
			if (slot.kind === "color" && slot.property === "background") {
				node.background = value;
				return "applied";
			}
			return "unsupported";
		case "rect":
		case "ellipse":
		case "polygon":
		case "star":
		case "path":
			if (FILL_STROKE_KINDS.has(node.type)) {
				if (slot.kind === "color" && (slot.property ?? "fill") === "fill") {
					node.fill = value;
					return "applied";
				}
				if (slot.kind === "color" && slot.property === "stroke") {
					node.stroke = value;
					return "applied";
				}
			}
			return "unsupported";
		case "line":
			if (slot.kind === "color" && slot.property === "stroke") {
				node.stroke = value;
				return "applied";
			}
			return "unsupported";
		default:
			return "unsupported";
	}
}

/**
 * Instantiates a {@link CanvasTemplateDefinition} into a fresh, normal Canvas IR
 * document (FR-022): every node/page gets a brand-new id (via `idFactory`, so
 * the same template can be instantiated any number of times without id
 * collisions), `variables` are resolved and stamped onto their slots' target
 * nodes, and `lockedNodeIds` are never mutated regardless of what a variable
 * would otherwise write there.
 *
 * Deterministic: given the same `definition`, `variables`, and fresh
 * `idFactory`/`nowFactory` instances producing the same sequence of values,
 * two calls produce deep-equal output.
 */
export function instantiateTemplate(
	definition: CanvasTemplateDefinition,
	options: InstantiateTemplateOptions = {},
): InstantiateTemplateResult {
	const idFactory = options.idFactory ?? defaultIdFactory;
	const nowFactory = options.nowFactory ?? nowIso;
	const warnings: InstantiateTemplateWarning[] = [];

	const cloned = structuredClone(definition.document);

	// Remap every page id and node id to a fresh one, keeping an old->new map
	// (for lockedNodeIds/slot lookups) and a new-id->node index (for O(1) slot
	// application below). Node subtrees go through the shared
	// `regenerateNodeIds` primitive (M0-05) — the idFactory call ORDER (page
	// ids first, then each page's subtree pre-order) is unchanged, so
	// deterministic-factory output is byte-identical to the previous inline
	// remap.
	const idMap = new Map<string, string>();
	const nodesByNewId = new Map<string, CanvasNode>();
	for (const page of cloned.pages) {
		const newPageId = idFactory();
		idMap.set(page.id, newPageId);
		page.id = newPageId;
	}
	for (const page of cloned.pages) {
		const { node: newRoot, idMap: subtreeIdMap } = regenerateNodeIds(
			page.root,
			{ idFactory },
		);
		page.root = newRoot;
		for (const [oldId, newId] of subtreeIdMap) {
			idMap.set(oldId, newId);
		}
	}
	walk(cloned, ({ node }) => {
		nodesByNewId.set(node.id, node);
	});

	const ts = nowFactory();
	cloned.id = idFactory();
	cloned.documentKind = "template-instance";
	cloned.metadata = { ...cloned.metadata, createdAt: ts, updatedAt: ts };

	const lockedNewIds = new Set(
		definition.lockedNodeIds
			.map((originalId) => idMap.get(originalId))
			.filter((id): id is string => id !== undefined),
	);

	const { values, warnings: variableWarnings } = resolveTemplateVariables(
		definition,
		options.variables,
	);
	warnings.push(...variableWarnings);

	const slotsById = new Map(
		definition.editableSlots.map((slot) => [slot.id, slot] as const),
	);

	for (const variable of definition.variables) {
		const value = values[variable.id];
		if (value === undefined) continue; // unresolved; already warned above if required

		const slot = slotsById.get(variable.slotId);
		if (!slot) {
			warnings.push({
				code: "variable-slot-not-found",
				variableId: variable.id,
				slotId: variable.slotId,
			});
			continue;
		}

		const newNodeId = idMap.get(slot.nodeId);
		if (!newNodeId) {
			warnings.push({
				code: "slot-node-not-found",
				variableId: variable.id,
				slotId: slot.id,
				nodeId: slot.nodeId,
			});
			continue;
		}

		// Hard invariant: a locked node is never mutated by variable substitution.
		if (lockedNewIds.has(newNodeId)) continue;

		const node = nodesByNewId.get(newNodeId);
		if (!node) continue; // unreachable: every id in idMap's values came from nodesByNewId's keys
		if (applySlotValue(node, slot, value) === "unsupported") {
			warnings.push({
				code: "unsupported-slot-mutation",
				variableId: variable.id,
				slotId: slot.id,
				nodeId: newNodeId,
			});
		}
	}

	const document = CanvasIRSchema.parse(cloned);
	const command: CanvasBatchCommand = {
		type: "batch",
		label: `template:${definition.id}`,
		commands: document.pages.map(
			(page): CanvasPageCreateCommand => ({ type: "page.create", page }),
		),
	};

	return { document, command, warnings };
}
