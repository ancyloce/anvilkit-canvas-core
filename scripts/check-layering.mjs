#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const SOURCE_DIR = resolve(PACKAGE_ROOT, "src");

/**
 * Dependency-direction gate for the domain layout documented in this package's
 * own docs/architecture/src-layer-map.md. (It previously cited the
 * superproject's canvas-core-src-layout-review.md — a file that does not ship
 * with this submodule, so the record was unreachable from a standalone clone
 * and had drifted out of date. See OQ-2 / T-M1-07.) A module may only
 * import strictly lower-ranked domains (or its own domain). This is a coarse
 * direction check, not the full per-domain allowlist — its job is to stop
 * upward edges (e.g. ir/ importing extensions/) from creeping back in.
 * `__tests__` and *.test.ts files are exempt importers.
 *
 * A source file that matches no layer fails the check on purpose: new
 * top-level files/directories must be added here (and to the review doc)
 * so their layer assignment is a conscious decision.
 */
const LAYERS = [
	{ domain: "clock", rank: 0, match: (p) => p === "clock.ts" },
	// Central resource ceilings (T-M0-03). MUST rank below `ir` because
	// `ir/walkers.ts` imports MAX_TREE_DEPTH from it; it imports nothing
	// itself, so rank 0 alongside `clock` is the correct floor.
	{ domain: "limits", rank: 0, match: (p) => p === "limits.ts" },
	// Deterministic string fingerprints (T-M2-03). Imported by BOTH
	// `serialize/` (rank 5, XML id disambiguation) and `layout/` (rank 4,
	// measurement keys + inputHash); rank 4 cannot reach rank 5, so the shared
	// algorithm has to sit below both. It imports nothing, so rank 0 is the
	// correct floor rather than an arbitrary low rank.
	{ domain: "hash", rank: 0, match: (p) => p === "hash.ts" },
	// Shared URI scheme allowlist (plan 0021 T-009). Extracted from
	// `serialize/svg.ts` (rank 5) because `component-libraries/` (rank 4) must
	// sanitize Provider-supplied release-notes/thumbnail URLs and cannot import
	// upward. It imports nothing, so rank 0 is the correct floor — the same
	// reasoning that created `limits.ts` and `hash.ts`. `serialize/svg.ts`
	// re-exports its names, so this consolidation breaks no importer.
	{ domain: "uri", rank: 0, match: (p) => p === "uri.ts" },
	{ domain: "ir", rank: 1, match: (p) => p.startsWith("ir/") },
	{ domain: "ai-contracts", rank: 2, match: (p) => p === "ai-contracts.ts" },
	// The headless text-measurement port. A host-implemented contract over IR
	// types, exactly like ai-contracts — so it sits at the same rank: it may read
	// `ir/` (rank 1) and nothing above.
	{ domain: "text-contracts", rank: 2, match: (p) => p === "text-contracts.ts" },
	{ domain: "geometry", rank: 2, match: (p) => p.startsWith("geometry/") },
	// Clipboard payload schema + validation (A-03): pure data contract over ir.
	{ domain: "clipboard", rank: 2, match: (p) => p.startsWith("clipboard/") },
	// The headless export job contract (FR-040, canvas-m3-001). Reads `ir/`
	// only — it defines types + a document-resolution helper, never calls the
	// `serialize/` (rank 5) serializers itself. Same rank as ai-contracts/
	// text-contracts/geometry for the same reason.
	{ domain: "export", rank: 2, match: (p) => p.startsWith("export/") },
	// The headless comment anchor contract (FR-072, canvas-m5-003). Reads `ir/`
	// only — a discriminated union + resolver over page/node ids, never touches
	// commands/extensions. Same rank as ai-contracts/text-contracts/export.
	{
		domain: "comment-contracts",
		rank: 2,
		match: (p) => p === "comment-contracts.ts",
	},
	// Local Components resolver-side domain (PLAN 0023 M1, TD §22). Reads
	// `ir/` only. The PERSISTED component shapes (definition/registry/
	// property/override types + schemas) follow the layout/ precedent
	// documented below: they live in `ir/` at rank 1, because `ir/types.ts`
	// owns `CanvasIR.components` and `ir/validators.ts` spreads the schemas —
	// rank 1 cannot import upward. Only resolver-side contracts and logic
	// (identity, graph, resolve, cache — M2) belong here.
	{ domain: "components", rank: 2, match: (p) => p.startsWith("components/") },
	// The brand-policy decision port (plan 0021 T-003/T-038, D-3). A
	// host-implemented contract over `ir/` types only — the same shape as
	// `text-contracts.ts`/`comment-contracts.ts`, hence the same rank.
	//
	// Rank 2 is what makes the enforcement design work: `commands/` (rank 3)
	// can import the port, so every mutation path can consult policy. It is
	// ALSO why `clipboard/` (rank 2, a same-rank sibling) cannot — clipboard
	// policy is therefore enforced in the CALLER (the Editor action layer and
	// the paste command at rank >= 3), and `clipboard/payload.ts` itself stays
	// policy-free. See plan 0021 §4.2.
	{
		domain: "policy-contracts",
		rank: 2,
		match: (p) => p === "policy-contracts.ts",
	},
	{ domain: "commands", rank: 3, match: (p) => p.startsWith("commands/") },
	{ domain: "extensions", rank: 4, match: (p) => p.startsWith("extensions/") },
	// Template definition/instantiation (FR-020..022). Same rank as extensions —
	// it needs ir + commands (for the reversible-batch instantiation wrapper,
	// canvas-m2-003) but never touches extensions, and vice versa.
	{ domain: "templates", rank: 4, match: (p) => p.startsWith("templates/") },
	// Component document operations (PLAN 0023, decision D-1): FOLDED INTO
	// the `templates` domain rather than given a separate rank-4 domain.
	// TD §16.3 makes `templates/instantiate.ts` ↔ component-import coupling
	// inevitable, and equal-rank cross-domain imports are violations —
	// same-domain membership is what keeps that edge legal.
	{
		domain: "templates",
		rank: 4,
		match: (p) => p.startsWith("component-ops/"),
	},
	// The canonical Brand Kit contract (FR-031) + apply-brand transforms
	// (FR-032, canvas-m2-006). Bumped from rank 2 to rank 4 in canvas-m2-006:
	// the contract itself only reads `ir/`, but `applyBrandColors`/etc. wrap
	// their edits as a reversible `commands/` batch, the same pattern
	// `templates/` uses — so brand needs the same rank templates has.
	{ domain: "brand", rank: 4, match: (p) => p.startsWith("brand/") },
	// The Auto Layout resolver and its validators (PLAN 0022 M1/M2). Rank 4
	// rather than something lower is forced, and forces four things in turn:
	//   1. layout COMMANDS stay in `commands/` (rank 3) — rank 3 cannot import
	//      rank 4, so composite commands take caller-computed geometry and
	//      `commands/` never calls the resolver;
	//   2. `export/` (rank 2) cannot import layout diagnostics, so export
	//      warnings are mapped caller-side into the open-string
	//      `CanvasExportWarning.code`;
	//   3. `templates/` (rank 4, a sibling) cannot import it either, which is
	//      why a layout-aware `resizeToVariants` is deferred, not attempted;
	//   4. the PERSISTED shapes (`CanvasAutoLayout`, `CanvasLayoutItem`,
	//      `CanvasDocumentCompatibility`, `CanvasLayoutMaterialization`) live
	//      in `ir/types.ts` at rank 1, because `ir/validators.ts` must type
	//      the shapes it spreads and `clipboard/` (rank 2) needs the
	//      capability type. Only RESOLVED-tree contracts belong here.
	{ domain: "layout", rank: 4, match: (p) => p.startsWith("layout/") },
	// External Component Libraries (plan 0021, D-3): canonicalization,
	// integrity, snapshot-key codec, admission, resolution, and the six
	// library commands. Needs `ir/` (1), `components/` (2) for the local
	// definition shapes, and `commands/` (3) for reversible batches — so rank
	// 4, a sibling of `templates`/`brand`/`layout`, is the floor.
	//
	// Two consequences the design depends on:
	//   1. `ir/` (rank 1) CANNOT import the snapshot-key Zod schema from here.
	//      The persisted shapes and their key validation must therefore be
	//      declared in `ir/` itself, exactly as `layout/` and `components/`
	//      already do — see the self-test case asserting this edge is illegal.
	//   2. `clipboard/` (rank 2) cannot import it either, so the M2
	//      `snapshotRefs` carry is validated caller-side.
	{
		domain: "component-libraries",
		rank: 4,
		match: (p) => p.startsWith("component-libraries/"),
	},
	{ domain: "serialize", rank: 5, match: (p) => p.startsWith("serialize/") },
	// Brand governance (plan 0021, D-3): the shared command policy gateway and
	// the component-aware compliance extensions. Reads `brand/` (4) and
	// `component-libraries/` (4) — two same-rank siblings that cannot reach
	// each other — plus `policy-contracts.ts` (2), so it must outrank all
	// three. Rank 5 alongside `serialize/` (no dependency either way).
	{
		domain: "brand-governance",
		rank: 5,
		match: (p) => p.startsWith("brand-governance/"),
	},
	// Design-level AI job contracts (FR-050/052, canvas-m4-001/003). Needs
	// BOTH templates (CanvasSizePreset id) and brand (BrandKitDefinition)
	// types — same-rank siblings that don't depend on each other — plus
	// commands (CanvasCommand payload shape) and ir/validators (schema
	// validation for canvas-m4-003's quarantine layer), so it must outrank
	// all of them, hence rank 5 alongside serialize (no dependency either
	// way between the two).
	{
		domain: "ai-design-contracts",
		rank: 5,
		match: (p) => p === "ai-design-contracts.ts",
	},
	{ domain: "root", rank: 6, match: (p) => p === "index.ts" },
];

const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?tsx?$/;
const IMPORT_SPECIFIER_PATTERN =
	/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

function classify(srcRelativePath) {
	return LAYERS.find((layer) => layer.match(srcRelativePath)) ?? null;
}

/** Returns a violation message for edge importer→importee, or null if legal. */
function checkEdge(importerPath, importeePath) {
	const importer = classify(importerPath);
	const importee = classify(importeePath);
	if (!importer) {
		return `${importerPath} matches no layer in check-layering.mjs — assign it one.`;
	}
	if (!importee) {
		return `${importerPath} imports ${importeePath}, which matches no layer in check-layering.mjs — assign it one.`;
	}
	if (importer.domain === importee.domain) return null;
	if (importer.rank > importee.rank) return null;
	return `${importerPath} -> ${importeePath}  (${importer.domain}, rank ${importer.rank}, must not depend on ${importee.domain}, rank ${importee.rank})`;
}

async function* walkSourceFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") {
				continue;
			}
			yield* walkSourceFiles(fullPath);
			continue;
		}
		if (
			entry.isFile() &&
			extname(entry.name) === ".ts" &&
			!TEST_FILE_PATTERN.test(entry.name)
		) {
			yield fullPath;
		}
	}
}

/** Resolve a relative specifier to a src-relative .ts path (posix separators). */
function resolveSpecifier(importerSrcRelative, specifier) {
	const joined = join(dirname(importerSrcRelative), specifier);
	const normalized = joined.split("\\").join("/");
	if (normalized.startsWith("..")) return null; // escapes src/ (not an internal edge)
	return normalized.replace(/\.js$/, ".ts");
}

async function collectViolations() {
	const violations = [];
	let edgeCount = 0;

	for await (const filePath of walkSourceFiles(SOURCE_DIR)) {
		const importerSrcRelative = relative(SOURCE_DIR, filePath)
			.split("\\")
			.join("/");
		const text = await readFile(filePath, "utf8");
		for (const match of text.matchAll(IMPORT_SPECIFIER_PATTERN)) {
			const importeeSrcRelative = resolveSpecifier(
				importerSrcRelative,
				match[1],
			);
			if (!importeeSrcRelative) continue;
			edgeCount += 1;
			const violation = checkEdge(importerSrcRelative, importeeSrcRelative);
			if (violation) violations.push(violation);
		}
	}

	return { violations, edgeCount };
}

function selfTest() {
	const cases = [
		// [importer, importee, expectViolation]
		["ir/validators.ts", "extensions/canvas-runtime.ts", true], // upward
		["extensions/canvas-runtime.ts", "ir/migrations.ts", false], // downward
		["geometry/affine.ts", "ai-contracts.ts", true], // equal rank, cross-domain
		["ir/builders.ts", "ir/validators.ts", false], // same domain
		["commands/runtime.ts", "clock.ts", false], // downward to leaf
		["clock.ts", "unmapped-thing.ts", true], // unmapped importee
		// --- plan 0021 M0 (T-003) -------------------------------------------
		// The port is reachable from the command layer: this is the whole
		// reason `policy-contracts.ts` sits at rank 2 rather than beside
		// `brand-governance/`.
		["commands/runtime.ts", "policy-contracts.ts", false],
		// ...but the gateway that USES the port is not. An enforcement helper
		// must never be imported downward into `commands/`.
		["commands/runtime.ts", "brand-governance/gateway.ts", true],
		// `clipboard/` is a same-rank sibling of the port, so it cannot consult
		// policy itself — paste enforcement lives in the caller.
		["clipboard/payload.ts", "policy-contracts.ts", true],
		// The gateway may read both rank-4 domains it composes.
		["brand-governance/gateway.ts", "brand/compliance.ts", false],
		["brand-governance/gateway.ts", "component-libraries/snapshot-key.ts", false],
		// ...and component-libraries may not reach back up into it.
		["component-libraries/admission.ts", "brand-governance/gateway.ts", true],
		// The shared URI allowlist is reachable from every domain that needs it,
		// including the rank-5 serializer it was extracted from.
		["component-libraries/limits.ts", "uri.ts", false],
		["serialize/svg.ts", "uri.ts", false],
		// Load-bearing M1 constraint: `ir/` cannot import the snapshot-key
		// schema, so the persisted registry shapes and their key validation
		// must be declared in `ir/` itself (as `layout/` and `components/`
		// already do). If this ever stops failing, the rank table moved.
		["ir/validators.ts", "component-libraries/snapshot-key.ts", true],
	];
	const failures = cases.filter(
		([importer, importee, expectViolation]) =>
			Boolean(checkEdge(importer, importee)) !== expectViolation,
	);
	if (failures.length > 0) {
		console.error("check-layering: SELF-TEST FAIL");
		for (const [importer, importee] of failures) {
			console.error(`  unexpected verdict for ${importer} -> ${importee}`);
		}
		process.exit(1);
	}
	console.log(`check-layering: self-test OK (${cases.length} cases).`);
}

async function main() {
	if (process.argv.includes("--self-test")) {
		selfTest();
		return;
	}

	const { violations, edgeCount } = await collectViolations();
	if (violations.length === 0) {
		console.log(
			`check-layering: OK — ${edgeCount} internal import edges respect the layer order.`,
		);
		return;
	}

	console.error("check-layering: FAIL");
	console.error("");
	console.error("The following imports point at an equal or higher layer:");
	console.error("");
	for (const violation of violations) {
		console.error(`  ${violation}`);
	}
	console.error("");
	console.error(
		"Lower layers must not depend on higher ones (see docs/architecture/src-layer-map.md).",
	);
	process.exit(1);
}

main().catch((error) => {
	console.error("check-layering: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
