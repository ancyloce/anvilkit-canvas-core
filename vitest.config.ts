import { nodePreset } from "@anvilkit/vitest-config/node";
import { defineConfig, mergeConfig } from "vitest/config";

export default mergeConfig(
	nodePreset,
	defineConfig({
		test: {
			name: "@anvilkit/canvas-core",
			passWithNoTests: true,
		},
	}),
);
