/**
 * @file Incremental compliance cache (plan 0021 T-043, TD 0016 §16.3).
 *
 * ## Why a cache alone was never the fix
 *
 * The Inspector's baseline ran a **whole-document** scan on every document *and
 * every selection* change, then discarded all but the selected nodes' issues.
 * A cache behind that caller would still have been asked a different question
 * each time the selection moved. So the cache is only half of T-043: the other
 * half is the caller no longer asking for a full report to answer a
 * per-instance question.
 *
 * ## The key is the invalidation contract
 *
 * An entry is valid while every input that can change its result is unchanged:
 * source integrity (a different version is different content), variant
 * selection, overrides, the policy, the Brand Kit, and the host's policy
 * revision. Anything missing from the key is a stale-result bug; anything extra
 * is a cache that never hits.
 */

import type { BrandComplianceIssue } from "../brand/compliance.js";
import { fingerprint64 } from "../hash.js";
import type { CanvasBrandComponentPolicy } from "../ir/component-policy.js";
import type { CanvasComponentInstanceNode } from "../ir/types.js";

export interface ComplianceCacheKeyParts {
	/** Exact source identity — integrity for external, revision for local. */
	readonly sourceKey: string;
	readonly variantHash: string;
	readonly overrideHash: string;
	readonly policyHash: string;
	readonly brandKitHash: string;
	/** Host policy revision; a change invalidates every entry. */
	readonly policyRevision: string;
}

/** Compose the §16.3 key. Length-prefixed so no part can forge a separator. */
export function composeComplianceCacheKey(
	parts: ComplianceCacheKeyParts,
): string {
	return [
		parts.sourceKey,
		parts.variantHash,
		parts.overrideHash,
		parts.policyHash,
		parts.brandKitHash,
		parts.policyRevision,
	]
		.map((part) => `${part.length}:${part}`)
		.join("|");
}

/** Stable hash of an instance's variant selection. */
export function variantHashOf(instance: CanvasComponentInstanceNode): string {
	const selection = instance.variantSelection;
	if (!selection) return "none";
	const keys = Object.keys(selection).sort();
	if (keys.length === 0) return "none";
	return fingerprint64(JSON.stringify(keys.map((k) => [k, selection[k]])));
}

/** Stable hash of an instance's override map. */
export function overrideHashOf(instance: CanvasComponentInstanceNode): string {
	const overrides = instance.overrides;
	if (!overrides) return "none";
	const keys = Object.keys(overrides).sort();
	if (keys.length === 0) return "none";
	return fingerprint64(JSON.stringify(keys.map((k) => [k, overrides[k]])));
}

/** Stable hash of a policy, order-independent. */
export function policyHashOf(
	policy: CanvasBrandComponentPolicy | undefined,
): string {
	if (!policy) return "none";
	const entries = Object.entries(policy).sort(([a], [b]) => (a < b ? -1 : 1));
	return fingerprint64(JSON.stringify(entries));
}

export interface CanvasComplianceCache {
	get(key: string): readonly BrandComplianceIssue[] | undefined;
	set(key: string, issues: readonly BrandComplianceIssue[]): void;
	/** Drop everything — used when the Brand Kit or policy revision changes. */
	clear(): void;
	readonly size: number;
	/** Hit/miss counts, for the perf test and for diagnostics. */
	stats(): { readonly hits: number; readonly misses: number };
}

/**
 * A bounded per-instance result cache.
 *
 * Bounded because a long editing session touches many instance states and an
 * unbounded map is a leak; eviction is insertion-order (oldest first), which is
 * adequate because a stale entry costs one rescan rather than a wrong answer.
 */
export function createComplianceCache(limit = 1024): CanvasComplianceCache {
	const entries = new Map<string, readonly BrandComplianceIssue[]>();
	let hits = 0;
	let misses = 0;

	return {
		get(key) {
			const value = entries.get(key);
			if (value) hits += 1;
			else misses += 1;
			return value;
		},
		set(key, issues) {
			if (entries.size >= limit) {
				const oldest = entries.keys().next().value;
				if (oldest !== undefined) entries.delete(oldest);
			}
			entries.set(key, issues);
		},
		clear() {
			entries.clear();
		},
		get size() {
			return entries.size;
		},
		stats() {
			return { hits, misses };
		},
	};
}
