import type {
	CanvasBatchCommand,
	CanvasPageCreateCommand,
} from "../commands/types.js";
import type {
	CanvasExportFormat,
	CanvasExportJobOptions,
	CanvasExportJobRequest,
	CanvasExportJobVariant,
} from "../export/types.js";
import type { CanvasIR, CanvasPage } from "../ir/types.js";
import { CanvasPageSchema } from "../ir/validators.js";
import { walkPage } from "../ir/walkers.js";
import type { CanvasSizePreset } from "./types.js";

function defaultIdFactory(): string {
	return crypto.randomUUID();
}

export interface ResizeToVariantsOptions {
	/** Injectable ID factory — call it once per fresh id needed. Defaults to `crypto.randomUUID`. */
	idFactory?: () => string;
}

export interface ResizeToVariantsResult {
	/** The newly generated variant pages — fresh ids throughout, sized per preset, `variantSource` stamped. */
	pages: CanvasPage[];
	/** One `page.create` per page in {@link ResizeToVariantsResult.pages}, as a single batch — apply via `applyCommand`/`applyCommands` (or a host's `ctx.commit`) for one reversible undo step. */
	command: CanvasBatchCommand;
}

/**
 * Generates one new, fully editable page per preset from an existing page's
 * content (FR-061, canvas-m3-007). Resolves PRD open question 3: variants are
 * pages **within the same document**, not separate documents — this keeps a
 * campaign's variants as one undo-able, exportable unit and matches how
 * `instantiateTemplate` already batches `page.create` for templates
 * (canvas-m2-003). A separate-document target was considered and rejected for
 * this MVP; nothing here forecloses adding it later if a real product need
 * surfaces.
 *
 * Content is copied as-is at each preset's dimensions — there is no automatic
 * reflow/rescale. The acceptance criteria call for "fully editable, manually
 * adjustable" variants, not automatic layout adaptation; a user (or a future
 * FR) repositions/rescales content to fit each target size after generation.
 *
 * Pure: `document` is read-only input, never mutated. Throws if `sourcePageId`
 * does not name a page in `document`.
 */
export function resizeToVariants(
	document: CanvasIR,
	sourcePageId: string,
	presets: readonly CanvasSizePreset[],
	options: ResizeToVariantsOptions = {},
): ResizeToVariantsResult {
	const idFactory = options.idFactory ?? defaultIdFactory;
	const sourcePage = document.pages.find((page) => page.id === sourcePageId);
	if (!sourcePage) {
		throw new Error(`resizeToVariants: no page with id "${sourcePageId}"`);
	}

	const pages = presets.map((preset): CanvasPage => {
		const cloned = structuredClone(sourcePage);
		walkPage(cloned, ({ node }) => {
			node.id = idFactory();
		});
		const page: CanvasPage = {
			...cloned,
			id: idFactory(),
			name: sourcePage.name
				? `${sourcePage.name} — ${preset.label}`
				: preset.label,
			size: {
				width: preset.width,
				height: preset.height,
				unit: preset.unit,
				...(preset.dpi !== undefined ? { dpi: preset.dpi } : {}),
			},
			variantSource: {
				sourcePageId,
				presetId: preset.id,
				presetVersion: preset.version,
			},
		};
		return CanvasPageSchema.parse(page);
	});

	const command: CanvasBatchCommand = {
		type: "batch",
		label: `resize:${sourcePageId}`,
		commands: pages.map(
			(page): CanvasPageCreateCommand => ({ type: "page.create", page }),
		),
	};

	return { pages, command };
}

export interface CampaignExportJobRequestOptions {
	id: string;
	format: CanvasExportFormat;
	options: CanvasExportJobOptions;
}

/**
 * Builds one {@link CanvasExportJobRequest} that exports every variant page
 * from a {@link resizeToVariants} call in a single batch (FR-061's "export
 * job can export all variants in one batch"). `document` must already contain
 * `variantPages` (apply the result's `command` first) — this only assembles
 * the request; executing a job is a worker/host concern (canvas-m3-001), not
 * `canvas-core`'s.
 */
export function buildCampaignExportJobRequest(
	document: CanvasIR,
	variantPages: readonly CanvasPage[],
	request: CampaignExportJobRequestOptions,
): CanvasExportJobRequest {
	return {
		id: request.id,
		source: { document },
		format: request.format,
		pages: variantPages.map((page) => page.id),
		variants: variantPages.map(
			(page): CanvasExportJobVariant => ({
				...(page.variantSource
					? { presetId: page.variantSource.presetId }
					: {}),
				pageId: page.id,
				...(page.name ? { label: page.name } : {}),
			}),
		),
		options: request.options,
	};
}
