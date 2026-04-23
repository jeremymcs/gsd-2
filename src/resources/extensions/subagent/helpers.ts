/**
 * Pure helpers for the subagent tool.
 *
 * Kept free of @gsd/* imports so unit tests can exercise them without pulling
 * the full subagent module (and its heavy dependencies) into scope.
 */

import * as fs from "node:fs";
import type { MergeResult } from "./isolation.js";

export const MAX_PARALLEL_TASKS_HARD_CAP = 8;
export const DEFAULT_CONCURRENCY = 4;

// ─── Mtime cache ────────────────────────────────────────────────────────────
// Generic mtime-based memoizer. Used by agents.ts to avoid re-reading and
// re-parsing every agent .md file on every tool invocation. Kept here (rather
// than in agents.ts) so it can be unit-tested without pulling in @gsd/* deps.

export interface MtimeCacheSources {
	/** Directories whose own mtime invalidates the entry when changed (catches file add/remove). */
	dirs: string[];
	/** File paths whose mtimes invalidate the entry when changed (catches content edits). */
	files: string[];
}

interface MtimeCacheEntry<T> {
	value: T;
	dirMtimes: Map<string, number | null>;
	fileMtimes: Map<string, number | null>;
}

export function statMtime(p: string): number | null {
	try {
		return fs.statSync(p).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * A keyed memoizer that invalidates when any recorded dir/file mtime has
 * changed since the last compute. `compute` returns both the value and the
 * source list observed while computing — these get recorded for the next
 * lookup's freshness check.
 */
export class MtimeCache<T> {
	private entries = new Map<string, MtimeCacheEntry<T>>();

	clear(): void {
		this.entries.clear();
	}

	get(key: string, compute: () => { value: T; sources: MtimeCacheSources }): T {
		const existing = this.entries.get(key);
		if (existing && this.isFresh(existing)) return existing.value;
		const { value, sources } = compute();
		const dirMtimes = new Map<string, number | null>();
		for (const d of sources.dirs) dirMtimes.set(d, statMtime(d));
		const fileMtimes = new Map<string, number | null>();
		for (const f of sources.files) fileMtimes.set(f, statMtime(f));
		this.entries.set(key, { value, dirMtimes, fileMtimes });
		return value;
	}

	private isFresh(entry: MtimeCacheEntry<T>): boolean {
		for (const [p, cachedMtime] of entry.dirMtimes) {
			if (statMtime(p) !== cachedMtime) return false;
		}
		for (const [p, cachedMtime] of entry.fileMtimes) {
			if (statMtime(p) !== cachedMtime) return false;
		}
		return true;
	}
}

/**
 * Run `fn` over each item with at most `concurrency` workers in flight.
 * Preserves input order in the output array.
 */
export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

// ─── Retry ──────────────────────────────────────────────────────────────────
// Subagent runs can fail for two very different reasons: a deterministic
// problem that retrying cannot possibly fix (unknown agent, blocked by phase
// conflict), or a transient one that often clears on its own (API rate limit,
// network blip, ephemeral process crash). Retrying the first category is
// wasted latency and $$$; retrying the second with exponential backoff is
// often enough to turn a red batch green.

/** Shape we need to inspect on a completed subagent run. Narrower than SingleResult so helpers.ts stays free of heavy imports. */
export interface RetryableSubagentResult {
	exitCode: number;
	stderr?: string;
	stopReason?: string;
}

/** Stderr patterns that indicate a deterministic, non-retriable failure. */
const DETERMINISTIC_STDERR_PATTERNS: RegExp[] = [
	// `runSingleAgent` returns this when an agent name isn't defined anywhere.
	/^Unknown agent:/m,
	// `conflictsWith` guard in index.ts; phase-conflict blocks don't clear by retrying.
	/is blocked: it conflicts with/m,
];

export function isRetriableFailure(result: RetryableSubagentResult, aborted: boolean): boolean {
	if (aborted) return false;
	if (result.exitCode === 0) return false;
	// `aborted` stopReason almost always comes with an abort signal; treat as non-retriable.
	if (result.stopReason === "aborted") return false;
	const stderr = result.stderr ?? "";
	for (const pattern of DETERMINISTIC_STDERR_PATTERNS) {
		if (pattern.test(stderr)) return false;
	}
	return true;
}

export interface RetryPolicy {
	/** Total attempts including the first one. `maxAttempts: 3` = 1 try + 2 retries. */
	maxAttempts: number;
	/** Backoff for the gap after attempt N is `min(baseDelayMs * 2^(N-1), maxDelayMs)`. */
	baseDelayMs: number;
	maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxAttempts: 3,
	baseDelayMs: 1000,
	maxDelayMs: 8000,
};

/** Compute the delay (ms) before attempt number `nextAttempt` (1-indexed, must be >= 2). */
export function backoffDelayMs(nextAttempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
	const previousAttempt = Math.max(1, nextAttempt - 1);
	const base = Math.min(policy.baseDelayMs * 2 ** (previousAttempt - 1), policy.maxDelayMs);
	// +/- 25% jitter to desynchronize retries across concurrent workers.
	const jitter = base * 0.25 * (random() * 2 - 1);
	return Math.max(0, Math.round(base + jitter));
}

function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (signal) {
			const onAbort = () => {
				clearTimeout(timer);
				resolve();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

/**
 * Execute `run` with retries on transient failures only. Aborts, deterministic
 * failures, and successes all return immediately. Between retries, wait
 * `backoffDelayMs` ms with ±25% jitter.
 */
export async function runWithRetry<T extends RetryableSubagentResult>(
	run: () => Promise<T>,
	policy: RetryPolicy = DEFAULT_RETRY_POLICY,
	signal?: AbortSignal,
	deps: {
		sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
		random?: () => number;
	} = {},
): Promise<T> {
	const sleep = deps.sleep ?? defaultSleep;
	const random = deps.random ?? Math.random;
	let lastResult: T | undefined;
	for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
		if (signal?.aborted) break;
		lastResult = await run();
		if (!isRetriableFailure(lastResult, signal?.aborted ?? false)) return lastResult;
		if (attempt < policy.maxAttempts) {
			const delay = backoffDelayMs(attempt + 1, policy, random);
			await sleep(delay, signal);
		}
	}
	// If we get here every attempt failed retriably (or signal aborted after the last attempt).
	// `lastResult` is defined unless the loop never executed, which only happens when the signal
	// was already aborted before the first attempt; in that case the caller should have short-circuited.
	return lastResult as T;
}

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
