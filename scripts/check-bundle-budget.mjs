#!/usr/bin/env node

/**
 * Bundle-budget gate — **every** `.size-limit.json` entry, not just the first.
 *
 * ## What this used to do wrong (plan 0021 T-002, risk B-2)
 *
 * The previous version read `Array.isArray(sizeLimit) ? sizeLimit[0] : sizeLimit`
 * and hard-coded `dist/index.js` as the measured artifact. With one entry that
 * was harmless. The moment a second entry existed — which is exactly what the
 * `./component-libraries` and `./brand-governance` subpaths introduced — every
 * budget after the first was **silently unmeasured**: the gate printed OK while
 * a subpath grew without limit. A budget nobody measures is worse than no
 * budget, because it reads as coverage.
 *
 * Now: iterate all entries, derive each one's import specifier from its own
 * `path`, measure each independently, and fail naming the offending entry.
 *
 * ## Why the specifier is derived, not configured
 *
 * `.size-limit.json` stays the single source of truth for what is measured and
 * against what budget, so `size-limit` and this gate cannot drift (the original
 * reason budgets live there). Rather than add a parallel `specifier` field that
 * could disagree with `path`, each entry's `path` is reverse-mapped through
 * `package.json` `exports` to the specifier a consumer would actually write.
 *
 * A `path` that matches no export target is a hard failure, not a skip — that
 * is the same class of bug as the original `[0]` read: a budget pointed at
 * something nobody can import measures nothing real.
 *
 * ## What is measured
 *
 * The entry chunk **plus every chunk statically reachable from it**. esbuild
 * runs with `splitting: true`, so code shared between statically-imported
 * modules can land in a separate chunk; measuring only the entry chunk would
 * let real, eagerly-loaded bytes escape the budget. Chunks reachable only
 * through `import()` are genuinely deferred, so they are reported separately
 * and excluded from the total.
 */

import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON = resolve(PACKAGE_ROOT, "package.json");
// Budget + externals come from .size-limit.json so the two gates cannot drift.
const SIZE_LIMIT_JSON = resolve(PACKAGE_ROOT, ".size-limit.json");
const TMP_DIR = resolve(PACKAGE_ROOT, ".bundle-check");
const PLATFORM = "node";

const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function parseLimitToBytes(limit) {
	const match = /^([\d.]+)\s*(B|KB|MB)$/i.exec(String(limit).trim());
	if (!match) {
		throw new Error(
			`check-bundle-budget: cannot parse size-limit "limit" value: ${limit}`,
		);
	}
	const value = Number.parseFloat(match[1]);
	const unit = match[2].toUpperCase();
	const factor = unit === "B" ? 1 : unit === "KB" ? 1024 : 1024 * 1024;
	return Math.round(value * factor);
}

/** Strip a leading `./` so exports targets and size-limit paths compare equal. */
function normalizeDistPath(value) {
	return String(value).replace(/^\.\//, "");
}

/**
 * Collect every `dist` JS target declared in `exports`, mapped to the specifier
 * a consumer writes to reach it.
 */
function collectExportTargets(pkg) {
	const targets = new Map();
	const exportsMap = pkg.exports ?? {};

	const specifierFor = (exportKey) =>
		exportKey === "." ? pkg.name : `${pkg.name}${exportKey.slice(1)}`;

	const record = (exportKey, target) => {
		if (typeof target !== "string") return;
		if (!target.endsWith(".js") && !target.endsWith(".cjs")) return;
		const normalized = normalizeDistPath(target);
		if (!targets.has(normalized)) {
			targets.set(normalized, specifierFor(exportKey));
		}
	};

	for (const [exportKey, exportValue] of Object.entries(exportsMap)) {
		if (exportKey === "./package.json") continue;
		if (typeof exportValue === "string") {
			record(exportKey, exportValue);
			continue;
		}
		if (exportValue === null || typeof exportValue !== "object") continue;
		for (const conditionValue of Object.values(exportValue)) {
			if (typeof conditionValue === "string") {
				record(exportKey, conditionValue);
				continue;
			}
			if (conditionValue === null || typeof conditionValue !== "object") continue;
			for (const target of Object.values(conditionValue)) {
				record(exportKey, target);
			}
		}
	}

	return targets;
}

async function loadInputs() {
	const [pkgRaw, sizeLimitRaw] = await Promise.all([
		readFile(PACKAGE_JSON, "utf8"),
		readFile(SIZE_LIMIT_JSON, "utf8"),
	]);

	const pkg = JSON.parse(pkgRaw);
	const parsed = JSON.parse(sizeLimitRaw);
	const rawEntries = Array.isArray(parsed) ? parsed : [parsed];

	if (rawEntries.length === 0) {
		throw new Error("check-bundle-budget: .size-limit.json declares no entries");
	}

	const exportTargets = collectExportTargets(pkg);

	const entries = rawEntries.map((entry, index) => {
		const label = entry?.name ?? entry?.path ?? `entry #${index}`;

		if (!entry || typeof entry.limit !== "string") {
			throw new Error(
				`check-bundle-budget: .size-limit.json entry ${label} must have a string \`limit\``,
			);
		}
		if (typeof entry.path !== "string") {
			throw new Error(
				`check-bundle-budget: .size-limit.json entry ${label} must have a string \`path\``,
			);
		}

		const distPath = normalizeDistPath(entry.path);
		const specifier = exportTargets.get(distPath);

		if (!specifier) {
			throw new Error(
				`check-bundle-budget: .size-limit.json entry ${label} has path "${entry.path}", which is not a \`dist\` target of any \`exports\` condition in package.json. ` +
					"Either fix the path or add the export — a budget on something no consumer can import measures nothing. " +
					`Known targets: ${[...exportTargets.keys()].join(", ")}`,
			);
		}

		return {
			name: entry.name ?? specifier,
			distPath,
			specifier,
			budget: parseLimitToBytes(entry.limit),
			limit: entry.limit,
			ignore: Array.isArray(entry.ignore) ? entry.ignore : [],
		};
	});

	return { pkg, entries };
}

async function ensureDistExists(entries) {
	for (const entry of entries) {
		try {
			await stat(resolve(PACKAGE_ROOT, entry.distPath));
		} catch {
			console.log(
				`check-bundle-budget: ${entry.distPath} missing — running \`pnpm build\``,
			);
			execFileSync(PNPM_BIN, ["build"], {
				cwd: PACKAGE_ROOT,
				stdio: "inherit",
			});
			return;
		}
	}
}

async function bundleEntry(entry, peerDependencies, index) {
	const workDir = resolve(TMP_DIR, `entry-${index}`);
	const entryFile = resolve(workDir, "entry.mjs");
	const outDir = resolve(workDir, "out");

	await rm(workDir, { recursive: true, force: true });
	await mkdir(workDir, { recursive: true });
	await writeFile(
		entryFile,
		`export * from ${JSON.stringify(entry.specifier)};\n`,
		"utf8",
	);

	const bases = [
		...new Set([
			...Object.keys(peerDependencies),
			...entry.ignore,
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
		]),
	];
	// Externalize subpaths too (esbuild externals are exact-match otherwise).
	const external = bases.flatMap((name) =>
		name.includes("/") && !name.startsWith("@") ? [name] : [name, `${name}/*`],
	);

	const result = await build({
		absWorkingDir: PACKAGE_ROOT,
		bundle: true,
		entryPoints: [entryFile],
		external,
		format: "esm",
		logLevel: "error",
		metafile: true,
		minify: true,
		outdir: outDir,
		platform: PLATFORM,
		splitting: true,
		target: "es2022",
		treeShaking: true,
		write: true,
	});

	if (result.errors.length > 0) {
		for (const error of result.errors) {
			console.error(error);
		}
		throw new Error(
			`check-bundle-budget: esbuild reported errors for ${entry.name}`,
		);
	}

	return { metafile: result.metafile, outDir };
}

function findEntryChunk(metafile, entryName) {
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (output.entryPoint) {
			return outputPath;
		}
	}

	throw new Error(
		`check-bundle-budget: could not locate the bundled entry chunk for ${entryName}`,
	);
}

/**
 * Every chunk reachable from `entryOutputPath` through STATIC imports.
 *
 * esbuild's `splitting: true` can hoist code shared between statically-imported
 * modules into its own chunk. Those bytes load eagerly with the entry, so they
 * belong inside the budget; only `dynamic-import` edges are genuinely deferred.
 */
function collectStaticChunks(metafile, entryOutputPath) {
	const reachable = new Set([entryOutputPath]);
	const queue = [entryOutputPath];

	while (queue.length > 0) {
		const current = queue.pop();
		const output = metafile.outputs[current];
		if (!output) continue;
		for (const imported of output.imports ?? []) {
			if (imported.kind === "dynamic-import") continue;
			if (imported.external) continue;
			if (!metafile.outputs[imported.path]) continue;
			if (reachable.has(imported.path)) continue;
			reachable.add(imported.path);
			queue.push(imported.path);
		}
	}

	return reachable;
}

/** Pure budget verdict, so the failure logic is self-testable. */
function evaluateEntry({ name, gzippedBytes, budget }) {
	return {
		name,
		gzippedBytes,
		budget,
		overBudget: gzippedBytes > budget,
		percentOfBudget: ((gzippedBytes / budget) * 100).toFixed(1),
	};
}

async function measureEntry(entry, peerDependencies, index) {
	const { metafile, outDir } = await bundleEntry(entry, peerDependencies, index);
	const entryOutputPath = findEntryChunk(metafile, entry.name);
	const staticChunks = collectStaticChunks(metafile, entryOutputPath);

	let rawBytes = 0;
	let gzippedBytes = 0;
	for (const chunkPath of staticChunks) {
		const bytes = await readFile(resolve(PACKAGE_ROOT, chunkPath));
		rawBytes += bytes.length;
		gzippedBytes += gzipSync(bytes, { level: 9 }).length;
	}

	const entryChunkName = basename(entryOutputPath);
	const staticChunkNames = [...staticChunks]
		.map((chunkPath) => basename(chunkPath))
		.filter((chunkName) => chunkName !== entryChunkName);
	const emitted = (await readdir(outDir)).filter((fileName) =>
		fileName.endsWith(".js"),
	);
	const deferredChunks = emitted.filter(
		(fileName) =>
			fileName !== entryChunkName && !staticChunkNames.includes(fileName),
	);

	return {
		...evaluateEntry({
			name: entry.name,
			gzippedBytes,
			budget: entry.budget,
		}),
		specifier: entry.specifier,
		distPath: entry.distPath,
		limit: entry.limit,
		rawBytes,
		entryChunkName,
		staticChunkNames,
		deferredChunks,
	};
}

function selfTest() {
	const cases = [
		// A single under-budget entry passes.
		{
			label: "single under budget",
			measured: [{ name: "a", gzippedBytes: 10, budget: 20 }],
			expectFailures: [],
		},
		// The regression this gate was rewritten for: the FIRST entry is fine and
		// the SECOND is over budget. The old script read only [0] and said OK.
		{
			label: "over-budget entry in a NON-FIRST position",
			measured: [
				{ name: "root", gzippedBytes: 10, budget: 20 },
				{ name: "subpath", gzippedBytes: 30, budget: 20 },
			],
			expectFailures: ["subpath"],
		},
		// Third position too, and more than one failure is reported at once.
		{
			label: "multiple over-budget entries",
			measured: [
				{ name: "root", gzippedBytes: 1, budget: 20 },
				{ name: "b", gzippedBytes: 21, budget: 20 },
				{ name: "c", gzippedBytes: 99, budget: 20 },
			],
			expectFailures: ["b", "c"],
		},
		// Exactly at budget is allowed; one byte over is not.
		{
			label: "exactly at budget",
			measured: [{ name: "a", gzippedBytes: 20, budget: 20 }],
			expectFailures: [],
		},
		{
			label: "one byte over budget",
			measured: [{ name: "a", gzippedBytes: 21, budget: 20 }],
			expectFailures: ["a"],
		},
	];

	const failures = [];
	for (const testCase of cases) {
		const actual = testCase.measured
			.map(evaluateEntry)
			.filter((result) => result.overBudget)
			.map((result) => result.name);
		if (actual.join(",") !== testCase.expectFailures.join(",")) {
			failures.push(
				`  ${testCase.label}: expected [${testCase.expectFailures.join(", ")}], got [${actual.join(", ")}]`,
			);
		}
	}

	// The static-chunk walker must include a shared SYNC chunk and exclude a
	// dynamic-only one, otherwise eagerly-loaded bytes escape the budget.
	const metafile = {
		outputs: {
			"out/entry.js": {
				entryPoint: "entry.mjs",
				imports: [
					{ path: "out/shared.js", kind: "import-statement" },
					{ path: "out/lazy.js", kind: "dynamic-import" },
					{ path: "zod", kind: "import-statement", external: true },
				],
			},
			"out/shared.js": {
				imports: [{ path: "out/deep.js", kind: "import-statement" }],
			},
			"out/deep.js": { imports: [] },
			"out/lazy.js": { imports: [] },
		},
	};
	const reachable = [...collectStaticChunks(metafile, "out/entry.js")].sort();
	const expected = ["out/deep.js", "out/entry.js", "out/shared.js"];
	if (reachable.join(",") !== expected.join(",")) {
		failures.push(
			`  static chunk walk: expected [${expected.join(", ")}], got [${reachable.join(", ")}]`,
		);
	}

	if (failures.length > 0) {
		console.error("check-bundle-budget: SELF-TEST FAIL");
		for (const failure of failures) {
			console.error(failure);
		}
		process.exit(1);
	}

	console.log(
		`check-bundle-budget: self-test OK (${cases.length} budget cases + static-chunk walk).`,
	);
}

async function main() {
	if (process.argv.includes("--self-test")) {
		selfTest();
		return;
	}

	// Run the self-test on every invocation, not just under the flag. It is pure
	// (no I/O, no bundling) so it costs nothing, and a gate whose own
	// over-budget detection is never exercised is how the `[0]` bug survived as
	// long as it did.
	selfTest();

	const { pkg, entries } = await loadInputs();
	await ensureDistExists(entries);
	await rm(TMP_DIR, { recursive: true, force: true });

	const results = [];
	for (const [index, entry] of entries.entries()) {
		results.push(await measureEntry(entry, pkg.peerDependencies ?? {}, index));
	}

	console.log(`check-bundle-budget: ${pkg.name} — ${results.length} entries`);
	for (const result of results) {
		console.log("");
		console.log(`  ${result.name}  (${result.specifier})`);
		console.log(`    entry chunk:     ${result.entryChunkName}`);
		console.log(
			`    shared (sync):   ${result.staticChunkNames.length > 0 ? result.staticChunkNames.join(", ") : "none"}`,
		);
		console.log(`    raw bytes:       ${result.rawBytes.toLocaleString()}`);
		console.log(`    gzipped:         ${result.gzippedBytes.toLocaleString()}`);
		console.log(
			`    budget:          ${result.budget.toLocaleString()} (${result.limit})`,
		);
		console.log(`    of budget:       ${result.percentOfBudget}%`);
		console.log(
			`    deferred chunks: ${result.deferredChunks.length > 0 ? result.deferredChunks.join(", ") : "none"}`,
		);
	}

	const over = results.filter((result) => result.overBudget);
	if (over.length > 0) {
		console.error("");
		for (const result of over) {
			console.error(
				`check-bundle-budget: FAIL — entry "${result.name}" (${result.specifier}) is ${result.gzippedBytes.toLocaleString()} bytes gzipped, exceeding its ${result.budget.toLocaleString()} byte (${result.limit}) budget by ${(result.gzippedBytes - result.budget).toLocaleString()} bytes.`,
			);
		}
		process.exit(1);
	}

	console.log("");
	console.log(
		`check-bundle-budget: OK — ${results.length}/${results.length} entries within budget.`,
	);
}

main().catch((error) => {
	console.error("check-bundle-budget: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
