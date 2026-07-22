/** Public face of the `serialize/` domain — imported only by the root barrel. */
export * from "./pdf.js";
// Curated, not `export *` (accidental-API-leak fix): svg.ts also exports its
// low-level emitter internals (`emitRect`/`emitStar`/`emitRichText`/
// `createEmitContext`/`fmt`/`sanitizeId`/`SvgEmitContext`/`ResolvedSvgOptions`/
// etc.) for its own tests to import directly — those are implementation
// details of the SVG emit pipeline, not part of this package's public
// surface, and should not appear in `@anvilkit/canvas-core`'s root API.
export type {
	SvgFetchAsset,
	SvgFontFaceDef,
	SvgImageMode,
	SvgResolveBrandToken,
	SvgSerializeOptions,
	SvgSerializeResult,
	SvgSerializeWarning,
	SvgWarningCode,
} from "./svg.js";
export { serializePageToSvg } from "./svg.js";
