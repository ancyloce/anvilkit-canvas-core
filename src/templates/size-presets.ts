import type { CanvasSizePreset } from "./types.js";

/**
 * The initial social size preset catalog (PRD FR-060, §12.8). Each entry's
 * `width`/`height` is the platform's own published dimension for that surface
 * as of this catalog's `version: "1"` — cited per-preset below since these
 * numbers drift as platforms redesign their apps; bump a preset's own
 * `version` (never mutate a shipped one in place) when a platform changes its
 * spec, so documents pinned to the old preset keep their original size.
 *
 * `safeArea` is only set for full-bleed short-form video surfaces where the
 * host app's own chrome (profile handle, caption, action rail) is known to
 * overlap the canvas edges — it is deliberately omitted where the format has
 * no such UI overlap (feed photos, thumbnails, banners).
 */
export const CANVAS_SIZE_PRESETS: readonly CanvasSizePreset[] = [
	{
		// Instagram's classic 1:1 feed post — the long-standing default square
		// crop every Instagram-aware tool supports.
		id: "instagram-post",
		version: "1",
		label: "Instagram Post",
		width: 1080,
		height: 1080,
		unit: "px",
		dpi: 72,
	},
	{
		// Instagram Stories render full-bleed 9:16; the top ~13% is commonly
		// obscured by the viewer's profile/username bar and the bottom ~13% by
		// the reply-bar UI, per Instagram's own ad safe-zone guidance.
		id: "instagram-story",
		version: "1",
		label: "Instagram Story",
		width: 1080,
		height: 1920,
		unit: "px",
		dpi: 72,
		safeArea: { top: 250, right: 0, bottom: 250, left: 0 },
	},
	{
		// Reels share the same 9:16 full-bleed canvas as Stories; a custom
		// cover image is cropped from this same safe area, so it reuses the
		// same UI-overlap margins.
		id: "instagram-reel-cover",
		version: "1",
		label: "Instagram Reel Cover",
		width: 1080,
		height: 1920,
		unit: "px",
		dpi: 72,
		safeArea: { top: 250, right: 0, bottom: 250, left: 0 },
	},
	{
		// TikTok's 9:16 canvas with its published creative safe-zone: keep key
		// text/logos clear of the top caption bar and the bottom
		// caption/sound-title area, and off the right-edge action rail
		// (like/comment/share icons).
		id: "tiktok-cover",
		version: "1",
		label: "TikTok Cover",
		width: 1080,
		height: 1920,
		unit: "px",
		dpi: 72,
		safeArea: { top: 150, right: 90, bottom: 290, left: 90 },
	},
	{
		// YouTube's recommended thumbnail size (16:9, 1280×720 minimum
		// recommended width per YouTube Studio's own guidance).
		id: "youtube-thumbnail",
		version: "1",
		label: "YouTube Thumbnail",
		width: 1280,
		height: 720,
		unit: "px",
		dpi: 72,
	},
	{
		// Facebook's recommended shared-link/feed image size (1.91:1), the
		// same aspect Facebook falls back to for Open Graph link previews.
		id: "facebook-post",
		version: "1",
		label: "Facebook Post",
		width: 1200,
		height: 630,
		unit: "px",
		dpi: 72,
	},
	{
		// LinkedIn's personal-profile background photo size.
		id: "linkedin-banner",
		version: "1",
		label: "LinkedIn Banner",
		width: 1584,
		height: 396,
		unit: "px",
		dpi: 72,
	},
	{
		// X (Twitter)'s recommended in-stream photo size (16:9) for a
		// single-image post.
		id: "x-twitter-post",
		version: "1",
		label: "X/Twitter Post",
		width: 1600,
		height: 900,
		unit: "px",
		dpi: 72,
	},
];

/** Looks up a preset in {@link CANVAS_SIZE_PRESETS} by its `id`. */
export function findSizePreset(id: string): CanvasSizePreset | undefined {
	return CANVAS_SIZE_PRESETS.find((preset) => preset.id === id);
}
