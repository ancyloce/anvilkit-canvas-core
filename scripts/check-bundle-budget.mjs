#!/usr/bin/env node

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
const DIST_ENTRY = resolve(PACKAGE_ROOT, "dist/index.js");
const TMP_DIR = resolve(PACKAGE_ROOT, ".bundle-check");
const ENTRY_FILE = resolve(TMP_DIR, "entry.mjs");
const OUT_DIR = resolve(TMP_DIR, "out");
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

async function loadInputs() {
	const [pkgRaw, sizeLimitRaw] = await Promise.all([
		readFile(PACKAGE_JSON, "utf8"),
		readFile(SIZE_LIMIT_JSON, "utf8"),
	]);

	const pkg = JSON.parse(pkgRaw);
	const sizeLimit = JSON.parse(sizeLimitRaw);
	const entry = Array.isArray(sizeLimit) ? sizeLimit[0] : sizeLimit;

	if (!entry || typeof entry.limit !== "string") {
		throw new Error(
			"check-bundle-budget: .size-limit.json must contain an entry with a string `limit`",
		);
	}

	return {
		pkg,
		budget: parseLimitToBytes(entry.limit),
		ignore: Array.isArray(entry.ignore) ? entry.ignore : [],
	};
}

async function ensureDistExists() {
	try {
		await stat(DIST_ENTRY);
	} catch {
		console.log(
			"check-bundle-budget: dist/index.js missing — running `pnpm build`",
		);
		execFileSync(PNPM_BIN, ["build"], {
			cwd: PACKAGE_ROOT,
			stdio: "inherit",
		});
	}
}

async function prepareEntry(packageName) {
	await rm(TMP_DIR, { recursive: true, force: true });
	await mkdir(TMP_DIR, { recursive: true });
	await writeFile(ENTRY_FILE, `export * from ${JSON.stringify(packageName)};\n`, "utf8");
}

async function bundle(packageName, peerDependencies, ignore) {
	const bases = [
		...new Set([
			...Object.keys(peerDependencies),
			...ignore,
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
		]),
	];
	// Externalize subpaths too (esbuild externals are exact-match otherwise).
	const external = bases.flatMap((name) =>
		name.includes("/") && !name.startsWith("@")
			? [name]
			: [name, `${name}/*`],
	);

	const result = await build({
		absWorkingDir: PACKAGE_ROOT,
		bundle: true,
		entryPoints: [ENTRY_FILE],
		external,
		format: "esm",
		logLevel: "error",
		metafile: true,
		minify: true,
		outdir: OUT_DIR,
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
		throw new Error("check-bundle-budget: esbuild reported errors");
	}

	return result.metafile;
}

function findEntryChunk(metafile) {
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (output.entryPoint) {
			return resolve(PACKAGE_ROOT, outputPath);
		}
	}

	throw new Error("check-bundle-budget: could not locate the bundled entry chunk");
}

async function main() {
	const { pkg, budget, ignore } = await loadInputs();
	await ensureDistExists();
	await prepareEntry(pkg.name);

	const metafile = await bundle(pkg.name, pkg.peerDependencies ?? {}, ignore);
	const entryChunkPath = findEntryChunk(metafile);
	const raw = await readFile(entryChunkPath);
	const gzipped = gzipSync(raw, { level: 9 });
	const rawBytes = raw.length;
	const gzippedBytes = gzipped.length;
	const percentOfBudget = ((gzippedBytes / budget) * 100).toFixed(1);
	const entryChunkName = basename(entryChunkPath);
	const asyncChunks = (await readdir(OUT_DIR)).filter(
		(fileName) => fileName.endsWith(".js") && fileName !== entryChunkName,
	);

	console.log(`check-bundle-budget: ${pkg.name}`);
	console.log(`  entry chunk:  ${entryChunkName}`);
	console.log(`  raw bytes:    ${rawBytes.toLocaleString()}`);
	console.log(`  gzipped:      ${gzippedBytes.toLocaleString()}`);
	console.log(`  budget:       ${budget.toLocaleString()}`);
	console.log(`  of budget:    ${percentOfBudget}%`);
	console.log(
		`  async chunks: ${asyncChunks.length > 0 ? asyncChunks.join(", ") : "none"}`,
	);

	if (gzippedBytes > budget) {
		console.error("");
		console.error(
			`check-bundle-budget: FAIL — ${gzippedBytes.toLocaleString()} bytes exceeds the ${budget.toLocaleString()} byte budget.`,
		);
		process.exit(1);
	}

	console.log("check-bundle-budget: OK");
}

main().catch((error) => {
	console.error("check-bundle-budget: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
