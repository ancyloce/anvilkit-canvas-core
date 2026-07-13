import { describe, expect, it } from "vitest";
import { CANVAS_SIZE_PRESETS, findSizePreset } from "../size-presets.js";
import { CanvasSizePresetSchema } from "../validators.js";

describe("CANVAS_SIZE_PRESETS", () => {
	it("validates every preset against CanvasSizePresetSchema", () => {
		for (const preset of CANVAS_SIZE_PRESETS) {
			expect(CanvasSizePresetSchema.safeParse(preset).success).toBe(true);
		}
	});

	it("has a unique id per preset", () => {
		const ids = CANVAS_SIZE_PRESETS.map((preset) => preset.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('starts every preset at version "1"', () => {
		for (const preset of CANVAS_SIZE_PRESETS) {
			expect(preset.version).toBe("1");
		}
	});

	it("includes the eight PRD FR-060 initial presets", () => {
		const ids = CANVAS_SIZE_PRESETS.map((preset) => preset.id).sort();
		expect(ids).toEqual(
			[
				"facebook-post",
				"instagram-post",
				"instagram-reel-cover",
				"instagram-story",
				"linkedin-banner",
				"tiktok-cover",
				"x-twitter-post",
				"youtube-thumbnail",
			].sort(),
		);
	});

	// Each dimension mirrors the platform's own published spec (see the
	// comment above each entry in size-presets.ts for the citation); this
	// fixture pins the exact numbers so a future edit that silently drifts a
	// value is caught here rather than only in the source file's comment.
	it.each([
		["instagram-post", 1080, 1080],
		["instagram-story", 1080, 1920],
		["instagram-reel-cover", 1080, 1920],
		["tiktok-cover", 1080, 1920],
		["youtube-thumbnail", 1280, 720],
		["facebook-post", 1200, 630],
		["linkedin-banner", 1584, 396],
		["x-twitter-post", 1600, 900],
	])("%s is %dx%d px", (id, width, height) => {
		const preset = findSizePreset(id);
		expect(preset?.width).toBe(width);
		expect(preset?.height).toBe(height);
		expect(preset?.unit).toBe("px");
	});

	it("sets a safe area only for full-bleed 9:16 short-form video surfaces", () => {
		const withSafeArea = [
			"instagram-story",
			"instagram-reel-cover",
			"tiktok-cover",
		];
		for (const preset of CANVAS_SIZE_PRESETS) {
			if (withSafeArea.includes(preset.id)) {
				expect(preset.safeArea).toBeDefined();
			} else {
				expect(preset.safeArea).toBeUndefined();
			}
		}
	});
});

describe("findSizePreset", () => {
	it("finds a preset by id", () => {
		expect(findSizePreset("instagram-post")?.label).toBe("Instagram Post");
	});

	it("returns undefined for an unknown id", () => {
		expect(findSizePreset("nonexistent")).toBeUndefined();
	});
});
