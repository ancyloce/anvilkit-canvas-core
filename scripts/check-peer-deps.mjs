#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = resolve(__dirname, "..");
const PACKAGE_JSON = resolve(PACKAGE_ROOT, "package.json");

// canvas-core is a leaf data package: no peers expected, and its dependency
// cone must stay React-free and Konva-free (zod + pdf-lib only).
const FORBIDDEN_RUNTIME_DEPS = ["react", "react-dom", "react-konva", "konva"];

async function main() {
	const pkg = JSON.parse(await readFile(PACKAGE_JSON, "utf8"));
	const dependencies = pkg.dependencies ?? {};
	const peerDependencies = pkg.peerDependencies ?? {};

	const unexpectedPeers = Object.keys(peerDependencies);
	const forbiddenDeps = FORBIDDEN_RUNTIME_DEPS.filter(
		(name) => name in dependencies || name in peerDependencies,
	);

	if (unexpectedPeers.length === 0 && forbiddenDeps.length === 0) {
		console.log(
			"check-peer-deps: OK — no peer dependencies, and the runtime dependency cone is React/Konva-free.",
		);
		return;
	}

	console.error("check-peer-deps: FAIL");
	console.error("");

	if (unexpectedPeers.length > 0) {
		console.error(
			`  Unexpected peerDependencies: ${unexpectedPeers.join(", ")}`,
		);
		console.error(
			"  canvas-core is expected to have zero peers. If a peer is now intentional, update this script's expectations alongside the change.",
		);
		console.error("");
	}

	if (forbiddenDeps.length > 0) {
		console.error(
			`  Forbidden runtime dependencies: ${forbiddenDeps.join(", ")}`,
		);
		console.error(
			"  canvas-core must never depend on React or Konva. UI belongs in @anvilkit/canvas-editor.",
		);
		console.error("");
	}

	process.exit(1);
}

main().catch((error) => {
	console.error("check-peer-deps: crashed unexpectedly");
	console.error(error);
	process.exit(2);
});
