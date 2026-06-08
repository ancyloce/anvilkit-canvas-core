import { nodePreset } from "@anvilkit/vitest-config/node";
import { defineConfig, mergeConfig } from "vitest/config";

/**
 * `@anvilkit/canvas-core` is headless (node preset — no DOM/React/Konva).
 *
 * Coverage thresholds guard against silent regression of the IR / validator /
 * mutation / command / serializer logic. They are pinned a few points below the
 * current numbers (≈90% stmts / 86% branch) so a real drop fails the gate while
 * trivial refactors don't. Pure-type modules (no executable code) and the
 * re-export barrel are excluded. Enforce with `vitest run --coverage`.
 */
export default mergeConfig(
	nodePreset,
	defineConfig({
		test: {
			name: "@anvilkit/canvas-core",
			passWithNoTests: true,
			coverage: {
				provider: "v8",
				reporter: ["text", "html", "lcov"],
				include: ["src/**/*.ts"],
				exclude: [
					"src/**/*.test.ts",
					"src/**/__tests__/**",
					"src/types.ts",
					"src/ai-contracts.ts",
					"src/commands/types.ts",
					"src/index.ts",
				],
				thresholds: {
					statements: 87,
					branches: 83,
					functions: 92,
					lines: 87,
				},
			},
		},
	}),
);
