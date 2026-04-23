import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveConcurrency } from "../helpers.js";

describe("resolveConcurrency", () => {
	it("returns the default (4) when preferences are null", () => {
		assert.equal(resolveConcurrency(null), 4);
	});

	it("returns the default when preferences are undefined", () => {
		assert.equal(resolveConcurrency(undefined), 4);
	});

	it("returns the default when reactive_execution is absent", () => {
		assert.equal(resolveConcurrency({}), 4);
	});

	it("returns the default when max_parallel is absent", () => {
		assert.equal(resolveConcurrency({ reactive_execution: {} }), 4);
	});

	it("honors an in-range integer preference", () => {
		for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
			assert.equal(resolveConcurrency({ reactive_execution: { max_parallel: n } }), n);
		}
	});

	it("floors fractional values", () => {
		assert.equal(resolveConcurrency({ reactive_execution: { max_parallel: 3.9 } }), 3);
	});

	it("falls back to default when below the valid range", () => {
		assert.equal(resolveConcurrency({ reactive_execution: { max_parallel: 0 } }), 4);
		assert.equal(resolveConcurrency({ reactive_execution: { max_parallel: -1 } }), 4);
	});

	it("falls back to default when above the hard cap (8)", () => {
		assert.equal(resolveConcurrency({ reactive_execution: { max_parallel: 9 } }), 4);
		assert.equal(resolveConcurrency({ reactive_execution: { max_parallel: 100 } }), 4);
	});

	it("falls back to default for non-numeric values", () => {
		assert.equal(
			resolveConcurrency({ reactive_execution: { max_parallel: "3" as unknown as number } }),
			4,
		);
		assert.equal(
			resolveConcurrency({ reactive_execution: { max_parallel: Number.NaN } }),
			4,
		);
		assert.equal(
			resolveConcurrency({ reactive_execution: { max_parallel: Number.POSITIVE_INFINITY } }),
			4,
		);
	});
});
