#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args) {
	const result = spawnSync(command, args, {
		cwd: PACKAGE_ROOT,
		stdio: "inherit",
	});

	if (result.error) {
		throw result.error;
	}

	return result.status ?? 0;
}

function main() {
	const tempDir = mkdtempSync(join(tmpdir(), "anvilkit-canvas-core-publint-"));

	try {
		const packStatus = run(PNPM_BIN, [
			"pack",
			"--pack-destination",
			tempDir,
			"--config.ignore-scripts=true",
		]);

		if (packStatus !== 0) {
			process.exit(packStatus);
		}

		const tarball = readdirSync(tempDir).find((file) => file.endsWith(".tgz"));
		if (!tarball) {
			console.error("check-publint: FAIL — pnpm pack did not create a tarball.");
			process.exit(1);
		}

		const publintStatus = run(PNPM_BIN, [
			"exec",
			"publint",
			resolve(tempDir, tarball),
			"--pack",
			"false",
		]);

		process.exit(publintStatus);
	} finally {
		rmSync(tempDir, { force: true, recursive: true });
	}
}

try {
	main();
} catch (error) {
	console.error("check-publint: crashed unexpectedly");
	console.error(error);
	process.exit(2);
}
