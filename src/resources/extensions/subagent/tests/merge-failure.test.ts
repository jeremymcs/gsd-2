import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MergeResult } from "../isolation.js";
import { formatMergeFailureText } from "../helpers.js";

describe("formatMergeFailureText", () => {
	it("renders failed patch list when present", () => {
		const mergeResult: MergeResult = {
			success: false,
			appliedPatches: ["a.patch"],
			failedPatches: ["b.patch", "c.patch"],
			error: "conflict in src/foo.ts",
		};
		const text = formatMergeFailureText("agent said hi", mergeResult);

		assert.match(text, /agent said hi/);
		assert.match(text, /✗ Patch merge failed: conflict in src\/foo\.ts/);
		assert.match(text, /Failed patches: b\.patch, c\.patch/);
		assert.match(text, /Applied: 1\/3\./);
	});

	it("uses '(none listed)' when no failed patch paths were recorded", () => {
		const mergeResult: MergeResult = {
			success: false,
			appliedPatches: [],
			failedPatches: [],
			error: "git apply exited 1",
		};
		const text = formatMergeFailureText("body", mergeResult);
		assert.match(text, /Failed patches: \(none listed\)/);
	});

	it("falls back to 'unknown error' when no error string is set", () => {
		const mergeResult: MergeResult = {
			success: false,
			appliedPatches: [],
			failedPatches: ["x.patch"],
		};
		const text = formatMergeFailureText("body", mergeResult);
		assert.match(text, /✗ Patch merge failed: unknown error/);
	});
});
