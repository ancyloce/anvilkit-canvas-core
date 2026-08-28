import { nowIso } from "../clock.js";
import type {
	CanvasBatchCommand,
	CanvasCommand,
	CanvasComponentCreateCommand,
	CanvasPageCreateCommand,
} from "../commands/types.js";
import { validateComponentGraph } from "../components/validate.js";
import { localComponentIdOf } from "../ir/component-source.js";
import { assertCanvasDocumentBudget } from "../ir/document-budget.js";
import { regenerateNodeIds } from "../ir/regenerate-ids.js";
import type {
	CanvasComponentDefinition,
	CanvasIR,
	CanvasNode,
} from "../ir/types.js";
import { migrateCanvasIR } from "../ir/validators.js";
import { isContainerNode, walk } from "../ir/walkers.js";
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
	| "unsupported-slot-mutation"
	/** The imported component graph reported an error-severity issue (M3-11). */
	| "component-graph-invalid";

export interface InstantiateTemplateWarning {
	code: InstantiateTemplateWarningCode;
	variableId?: string;
	slotId?: string;
	nodeId?: string;
	componentId?: string;
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
				// Content (unlike font/color, below) must land in exactly one
				// place — the first span — or a multi-span/multi-paragraph node
				// renders the slot value duplicated once per span (C-5). Every
				// other span keeps its style but is emptied, not removed, so
				// paragraph/span structure (and per-span styling) survives.
				let wrote = false;
				for (const paragraph of node.paragraphs) {
					for (const span of paragraph.spans) {
						span.text = wrote ? "" : value;
						wrote = true;
					}
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

	// A provider-supplied template is untrusted input. Admit it before cloning,
	// id regeneration, variable resolution, or any other document-wide work.
	assertCanvasDocumentBudget(definition.document);
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

	// plan 0023 M3-11 (LC-DOCFLOW): a template's `document` is a full CanvasIR,
	// so Component Sources ride in `document.components` — no bundle format.
	// Every import remaps ONCE through the same factory + shared id map:
	// definition ids, Source node ids, property bindings, nested references,
	// and page instances — so instantiating one template any number of times
	// can never collide (collision policy: always-remap; identical-definition
	// reuse is deliberately P1). The factory-call ORDER extends the existing
	// deterministic sequence (pages, page subtrees, THEN the registry in
	// sorted-id order), so component-free templates keep byte-identical output.
	const sourceRegistry = cloned.components ?? {};
	const sourceDefinitionIds = Object.keys(sourceRegistry).sort();
	if (sourceDefinitionIds.length > 0) {
		const componentIdMap = new Map<string, string>();
		for (const id of sourceDefinitionIds) {
			componentIdMap.set(id, idFactory());
		}
		const remappedRegistry: Record<string, CanvasComponentDefinition> = {};
		for (const id of sourceDefinitionIds) {
			const definition = sourceRegistry[id] as CanvasComponentDefinition;
			const { node: newRoot, idMap: subtreeIdMap } = regenerateNodeIds(
				definition.root,
				{ idFactory },
			);
			for (const [oldId, newId] of subtreeIdMap) idMap.set(oldId, newId);
			const newId = componentIdMap.get(id) as string;
			remappedRegistry[newId] = {
				...definition,
				id: newId,
				root: newRoot,
				// Property IDs are stable (INV-6); bindings follow the remap.
				properties: definition.properties.map((property) => ({
					...property,
					nodeId: subtreeIdMap.get(property.nodeId) ?? property.nodeId,
				})),
			};
		}
		// One shared map rewrites every reference — nested instances inside
		// Source trees and instances on the template's pages alike.
		const rewriteInstanceRefs = (node: CanvasNode): void => {
			if (node.type === "component-instance") {
				// Only local Sources are cloned-and-renamed by instantiation; an
				// external ref addresses a library, not a tree in this template,
				// so it is carried through untouched.
				const localId = localComponentIdOf(node.source);
				if (localId !== undefined) {
					const mapped = componentIdMap.get(localId);
					if (mapped) node.source = { kind: "local", componentId: mapped };
				}
			}
			if (isContainerNode(node)) {
				for (const child of node.children) rewriteInstanceRefs(child);
			}
		};
		for (const definition of Object.values(remappedRegistry)) {
			rewriteInstanceRefs(definition.root);
		}
		for (const page of cloned.pages) {
			rewriteInstanceRefs(page.root);
		}
		cloned.components = remappedRegistry;
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

	// The shared migrate seam, NOT a bare `CanvasIRSchema.parse`. A template's
	// stored `document` is persisted content like any other: it can have been
	// authored against an older IR version, and parsing it directly would
	// reject it with a cryptic schema error instead of upgrading it. Routing
	// through `migrateCanvasIR` means template instantiation follows the same
	// read version -> migrate -> validate path as loading, collab decode, and
	// export resolution, so no document-entry path bypasses migration.
	const document = migrateCanvasIR(cloned);

	// Validate the imported component graph (M3-11): error-severity issues
	// surface as warnings — the standalone document still opens (instances
	// degrade to selectable placeholders, INV-3), while the COMMAND path stays
	// hard-guarded by `component.create`'s own graph checks at apply time.
	if (document.components) {
		for (const issue of validateComponentGraph(document)) {
			if (issue.severity !== "error") continue;
			warnings.push({
				code: "component-graph-invalid",
				componentId: issue.componentId,
			});
		}
	}

	// Definitions land BEFORE the pages that reference them, so applying the
	// batch into an existing document never has an instance pointing at a
	// not-yet-imported Source, and `component.create`'s freshness/graph guards
	// run against the target document.
	const componentCommands = Object.keys(document.components ?? {})
		.sort()
		.map((id): CanvasComponentCreateCommand => {
			const imported = document.components?.[id] as CanvasComponentDefinition;
			return {
				type: "component.create",
				mode: "restore",
				definition: imported,
			};
		});
	const command: CanvasBatchCommand = {
		type: "batch",
		label: `template:${definition.id}`,
		commands: [
			...(componentCommands as CanvasCommand[]),
			...document.pages.map(
				(page): CanvasPageCreateCommand => ({ type: "page.create", page }),
			),
		],
	};

	return { document, command, warnings };
}
