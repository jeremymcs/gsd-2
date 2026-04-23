import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_RETRY_POLICY,
	type RetryPolicy,
	type RetryableSubagentResult,
	backoffDelayMs,
	isRetriableFailure,
	runWithRetry,
} from "../helpers.js";

describe("isRetriableFailure", () => {
	it("returns false when aborted", () => {
		assert.equal(isRetriableFailure({ exitCode: 1 }, true), false);
	});

	it("returns false on success", () => {
		assert.equal(isRetriableFailure({ exitCode: 0 }, false), false);
	});

	it("returns true on generic non-zero exit", () => {
		assert.equal(isRetriableFailure({ exitCode: 1, stderr: "boom" }, false), true);
	});

	it("returns false for 'Unknown agent:' stderr", () => {
		assert.equal(
			isRetriableFailure({ exitCode: 1, stderr: 'Unknown agent: "bogus". Available agents: ...' }, false),
			false,
		);
	});

	it("returns false for phase-conflict blocks", () => {
		assert.equal(
			isRetriableFailure(
				{ exitCode: 1, stderr: 'Agent "planner" is blocked: it conflicts with the active GSD phase' },
				false,
			),
			false,
		);
	});

	it("returns false when stopReason is 'aborted' even without signal", () => {
		assert.equal(isRetriableFailure({ exitCode: 1, stopReason: "aborted" }, false), false);
	});
});

describe("backoffDelayMs", () => {
	const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 8000 };

	it("computes doubling base delays (midpoint, no jitter)", () => {
		// With random() = 0.5, jitter term collapses to 0.
		const fixed = () => 0.5;
		assert.equal(backoffDelayMs(2, policy, fixed), 1000);
		assert.equal(backoffDelayMs(3, policy, fixed), 2000);
		assert.equal(backoffDelayMs(4, policy, fixed), 4000);
		assert.equal(backoffDelayMs(5, policy, fixed), 8000);
	});

	it("caps at maxDelayMs", () => {
		const fixed = () => 0.5;
		assert.equal(backoffDelayMs(10, policy, fixed), 8000);
		assert.equal(backoffDelayMs(100, policy, fixed), 8000);
	});

	it("applies ±25% jitter based on random()", () => {
		// random() returns 0 -> jitter = -25% of base
		const minRandom = () => 0;
		assert.equal(backoffDelayMs(2, policy, minRandom), 750);
		// random() returns ~1 -> jitter = +25% of base
		const maxRandom = () => 1;
		assert.equal(backoffDelayMs(2, policy, maxRandom), 1250);
	});

	it("never returns a negative delay", () => {
		const tiny: RetryPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 };
		const minRandom = () => 0;
		assert.ok(backoffDelayMs(2, tiny, minRandom) >= 0);
	});
});

describe("runWithRetry", () => {
	const fastPolicy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 };
	const noSleep = async () => {};

	it("returns success immediately without retries", async () => {
		let calls = 0;
		const run = async (): Promise<RetryableSubagentResult> => {
			calls++;
			return { exitCode: 0 };
		};
		const r = await runWithRetry(run, fastPolicy, undefined, { sleep: noSleep });
		assert.equal(r.exitCode, 0);
		assert.equal(calls, 1);
	});

	it("returns immediately on a deterministic failure without retrying", async () => {
		let calls = 0;
		const run = async (): Promise<RetryableSubagentResult> => {
			calls++;
			return { exitCode: 1, stderr: "Unknown agent: foo" };
		};
		const r = await runWithRetry(run, fastPolicy, undefined, { sleep: noSleep });
		assert.equal(r.exitCode, 1);
		assert.equal(calls, 1);
	});

	it("retries transient failures up to maxAttempts", async () => {
		let calls = 0;
		const run = async (): Promise<RetryableSubagentResult> => {
			calls++;
			return { exitCode: 1, stderr: "ephemeral" };
		};
		await runWithRetry(run, fastPolicy, undefined, { sleep: noSleep });
		assert.equal(calls, 3);
	});

	it("stops retrying as soon as a retry succeeds", async () => {
		let calls = 0;
		const run = async (): Promise<RetryableSubagentResult> => {
			calls++;
			return calls < 2 ? { exitCode: 1, stderr: "blip" } : { exitCode: 0 };
		};
		const r = await runWithRetry(run, fastPolicy, undefined, { sleep: noSleep });
		assert.equal(r.exitCode, 0);
		assert.equal(calls, 2);
	});

	it("sleeps with the computed backoff between attempts", async () => {
		const sleeps: number[] = [];
		const sleep = async (ms: number) => {
			sleeps.push(ms);
		};
		const run = async (): Promise<RetryableSubagentResult> => ({ exitCode: 1, stderr: "x" });
		await runWithRetry(
			run,
			{ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 },
			undefined,
			{ sleep, random: () => 0.5 },
		);
		// Two gaps between 3 attempts.
		assert.deepEqual(sleeps, [100, 200]);
	});

	it("short-circuits when the signal is already aborted", async () => {
		let calls = 0;
		const run = async (): Promise<RetryableSubagentResult> => {
			calls++;
			return { exitCode: 1, stderr: "x" };
		};
		const controller = new AbortController();
		controller.abort();
		await runWithRetry(run, fastPolicy, controller.signal, { sleep: noSleep });
		assert.equal(calls, 0);
	});

	it("does not retry once the run returns an aborted result", async () => {
		let calls = 0;
		const run = async (): Promise<RetryableSubagentResult> => {
			calls++;
			return { exitCode: 1, stopReason: "aborted" };
		};
		const r = await runWithRetry(run, fastPolicy, undefined, { sleep: noSleep });
		assert.equal(r.stopReason, "aborted");
		assert.equal(calls, 1);
	});

	it("defaults the policy to DEFAULT_RETRY_POLICY", async () => {
		let calls = 0;
		const run = async (): Promise<RetryableSubagentResult> => {
			calls++;
			return { exitCode: 0 };
		};
		await runWithRetry(run, undefined, undefined, { sleep: noSleep });
		assert.equal(calls, 1);
		assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 3);
	});
});
