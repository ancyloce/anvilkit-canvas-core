import { defineConfig } from "@rslib/core";

export default defineConfig({
	source: {
		entry: {
			index: [
				"./src/**/*.ts",
				"!./src/**/*.{test,spec}.ts",
				"!./src/**/__tests__/**",
			],
		},
	},
	lib: [
		{
			bundle: false,
			dts: {
				autoExtension: true,
			},
			id: "esm",
			format: "esm",
		},
		{
			bundle: false,
			dts: {
				autoExtension: true,
				distPath: "./dist/cjs",
			},
			id: "cjs",
			format: "cjs",
		},
	],
	output: {
		target: "web",
		externals: ["zod", "pdf-lib"],
	},
	performance: {
		// rslib defaults performance.buildCache to true, but rspack 2.x's
		// persistent cache storage is not concurrency-safe under Turbo's
		// parallel `^build` fan-out (concurrency: 32) -> SIGABRT or
		// silently missing/corrupted dist output (e.g. missing .d.ts).
		buildCache: false,
	},
});
