/**
 * @file Schema surface of the `components/` domain (plan 0023 M1-05).
 *
 * The persisted schemas live in `ir/validators.ts` (rank 1) — see the
 * layering note in `index.ts` — and are re-exported here. Resource caps
 * (M1-07, D-3) join this surface from `limits.ts`.
 */

export {
	buildCanvasComponentRegistrySchema,
	CanvasComponentDefinitionShape,
	CanvasComponentInstanceNodeSchema,
	CanvasComponentOverrideSchema,
	CanvasComponentPropertySchema,
	CanvasComponentRegistrySchema,
	CanvasTextOverrideValueSchema,
	omitEmptyComponents,
} from "../ir/validators.js";
export {
	MAX_COMPONENT_DEFINITIONS_PER_DOCUMENT,
	MAX_COMPONENT_EXPANDED_NODES_PER_RESOLUTION,
	MAX_COMPONENT_NESTED_DEPTH,
	MAX_COMPONENT_OVERRIDES_PER_INSTANCE,
	MAX_COMPONENT_PROPERTIES_PER_COMPONENT,
	MAX_COMPONENT_RICH_PARAGRAPHS_PER_OVERRIDE,
	MAX_COMPONENT_RICH_SPANS_PER_PARAGRAPH,
	MAX_COMPONENT_SOURCE_NODES_PER_DEFINITION,
	MAX_COMPONENT_TEXT_OVERRIDE_CHARS,
} from "../limits.js";
