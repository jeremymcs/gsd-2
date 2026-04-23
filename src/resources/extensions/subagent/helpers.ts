/**
 * Pure helpers for the subagent tool.
 *
 * Kept free of @gsd/* imports so unit tests can exercise them without pulling
 * the full subagent module (and its heavy dependencies) into scope.
 */

import type { MergeResult } from "./isolation.js";

export const MAX_PARALLEL_TASKS_HARD_CAP = 8;
export const DEFAULT_CONCURRENCY = 4;

/**
 * Resolve the effective parallel concurrency for subagent batches.
 *
 * Honors the user's `reactive_execution.max_parallel` preference when set to a
 * valid integer in [1, MAX_PARALLEL_TASKS_HARD_CAP]. Falls back to
 * {@link DEFAULT_CONCURRENCY} when the preference is absent or invalid. The
 * caller is expected to pass the already-loaded preferences object to avoid
 * loading them twice per invocation.
 */
export function resolveConcurrency(
	preferences: { reactive_execution?: { max_parallel?: unknown } } | null | undefined,
): number {
	const raw = preferences?.reactive_execution?.max_parallel;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_CONCURRENCY;
	const floored = Math.floor(raw);
	if (floored < 1 || floored > MAX_PARALLEL_TASKS_HARD_CAP) return DEFAULT_CONCURRENCY;
	return floored;
}

/**
 * Format an output text block with a merge-failure footer.
 *
 * Pure function so the formatting contract can be unit-tested without spawning
 * a subagent process.
 */
export function formatMergeFailureText(outputText: string, mergeResult: MergeResult): string {
	const applied = mergeResult.appliedPatches.length;
	const failed = mergeResult.failedPatches.length;
	const failedList = failed > 0 ? mergeResult.failedPatches.join(", ") : "(none listed)";
	const total = applied + failed;
	return (
		`${outputText}\n\n` +
		`✗ Patch merge failed: ${mergeResult.error ?? "unknown error"}\n` +
		`Failed patches: ${failedList}\n` +
		`Applied: ${applied}/${total || applied}.`
	);
}
