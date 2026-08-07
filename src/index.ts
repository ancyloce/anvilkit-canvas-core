export const CANVAS_CORE_VERSION = "0.1.2-rc.1";

export type * from "./ai-contracts.js";
export * from "./ai-design-contracts.js";
export * from "./brand/index.js";
export * from "./clipboard/index.js";
export * from "./commands/index.js";
export * from "./comment-contracts.js";
// TYPES ONLY, deliberately (plan 0021 §4.5). A consumer needs these to describe
// a document's external component references, and types are erased at runtime so
// they cost the 80 KB root budget nothing. Every VALUE in this domain —
// canonicalizer, schemas, codec, commands — stays behind the
// `@anvilkit/canvas-core/component-libraries` subpath. Do not widen this to
// `export *`.
export type {
	CanvasComponentSourceRef,
	CanvasExternalComponentRef,
} from "./component-libraries/types.js";
// Curated at `component-ops/index.ts` (plan 0023 M3) — document-operation
// builders that compose the resolver with the command layer.
export * from "./component-ops/index.js";
// Curated at `components/index.ts` (plan 0023 M1-11) — persisted shapes are
// re-exports of ir/ declarations; resolver internals stay private.
export * from "./components/index.js";
export * from "./export/index.js";
export * from "./extensions/index.js";
export * from "./geometry/index.js";
export * from "./ir/index.js";
// Curated at `layout/index.ts` — solver/cache internals are deliberately NOT
// re-exported here (T-M1-13). See that file's comment before adding a name.
export * from "./layout/index.js";
export * from "./limits.js";
export * from "./serialize/index.js";
export * from "./templates/index.js";
export * from "./text-contracts.js";
// ONE name only, deliberately. `normalizeUri`/`isSafeDataImageUrl` stay behind
// `serialize/svg.ts`'s re-export (their consumer is the emitter) and
// `sanitizeProviderUrl` behind the `component-libraries` subpath (its consumer
// is the Libraries UI). `isLocalObjectUri` is the one predicate a consumer
// OUTSIDE this package needs at the root: `@anvilkit/canvas-editor`'s exporters
// ask "is this asset's URI resolvable anywhere but here?" and must answer it
// with the same function the SVG serializer answers it with (cp1-006).
export { isLocalObjectUri } from "./uri.js";
