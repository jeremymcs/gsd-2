import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrencyLimit } from "../helpers.js";

describe("mapWithConcurrencyLimit", () => {
	it("returns an empty array for empty input", async () => {
		const results = await mapWithConcurrencyLimit<number, number>([], 4, async (n) => n);
		assert.deepEqual(results, []);
	});

	it("preserves input order in the output array regardless of completion order", async () => {
		const items = [5, 1, 3, 4, 2];
		const results = await mapWithConcurrencyLimit(items, 3, async (n) => {
			// Invert the relationship so faster items complete later.
			await new Promise((resolve) => setTimeout(resolve, 10 - n));
			return n * 10;
		});
		assert.deepEqual(results, [50, 10, 30, 40, 20]);
	});

	it("never exceeds the concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		const items = Array.from({ length: 20 }, (_, i) => i);
		await mapWithConcurrencyLimit(items, 4, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return n;
		});
		assert.ok(peak <= 4, `peak concurrency ${peak} exceeded limit 4`);
	});

	it("uses at least 1 worker even when concurrency is zero or negative", async () => {
		const items = [1, 2, 3];
		const results = await mapWithConcurrencyLimit(items, 0, async (n) => n * 2);
		assert.deepEqual(results, [2, 4, 6]);
	});

	it("caps the worker count at items.length", async () => {
		let active = 0;
		let peak = 0;
		const items = [1, 2];
		await mapWithConcurrencyLimit(items, 10, async (n) => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
			return n;
		});
		assert.ok(peak <= 2);
	});

	it("propagates rejections from the worker function", async () => {
		await assert.rejects(
			() => mapWithConcurrencyLimit([1, 2, 3], 2, async (n) => {
				if (n === 2) throw new Error("task failed");
				return n;
			}),
			/task failed/,
		);
	});
});
