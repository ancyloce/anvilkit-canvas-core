#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const API_SNAPSHOT_PATH = resolve(PACKAGE_ROOT, "api/api-snapshot.json");
const PNPM_BIN = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const UPDATE = process.argv.includes("--update");

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
	const tempDir = mkdtempSync(join(tmpdir(), "anvilkit-api-snapshot-"));
	const tempSnapshotPath = resolve(tempDir, "api-snapshot.json");
	const typedocStatus = run(PNPM_BIN, [
		"exec",
		"typedoc",
		"--options",
		"./typedoc.json",
		"--json",
		tempSnapshotPath,
		"--disableSources",
	]);

	if (typedocStatus !== 0) {
		rmSync(tempDir, { force: true, recursive: true });
		process.exit(typedocStatus);
	}

	const nextSnapshot = readFileSync(tempSnapshotPath, "utf8");
	const currentSnapshot = existsSync(API_SNAPSHOT_PATH)
		? readFileSync(API_SNAPSHOT_PATH, "utf8")
		: null;

	if (currentSnapshot === nextSnapshot) {
		rmSync(tempDir, { force: true, recursive: true });
		console.log("check-api-snapshot: OK — api/api-snapshot.json is up to date.");
		return;
	}

	if (UPDATE) {
		copyFileSync(tempSnapshotPath, API_SNAPSHOT_PATH);
		rmSync(tempDir, { force: true, recursive: true });
		console.log("check-api-snapshot: UPDATED — api/api-snapshot.json.");
		return;
	}

	rmSync(tempDir, { force: true, recursive: true });
	console.error(
		"check-api-snapshot: FAIL — api/api-snapshot.json is out of date. Run `pnpm update:api-snapshot` and commit the result.",
	);
	process.exit(1);
}

try {
	main();
} catch (error) {
	console.error("check-api-snapshot: crashed unexpectedly");
	console.error(error);
	process.exit(2);
}
