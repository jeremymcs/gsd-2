import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MtimeCache } from "../helpers.js";

/**
 * Tests for the MtimeCache that backs subagent discovery.
 *
 * These exercise the cache semantics directly (rather than through
 * `discoverAgents`) so they don't pull in the @gsd/pi-coding-agent chain
 * and don't need a working `getAgentDir()`. That keeps them independent of
 * the project's broader test-infra issues.
 */

let tmpRoot: string;

function writeFile(p: string, body: string): void {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, body);
}

function touchInFuture(p: string): void {
	const future = new Date(Date.now() + 10_000);
	fs.utimesSync(p, future, future);
}

before(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-cache-"));
});

after(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
	for (const entry of fs.readdirSync(tmpRoot)) {
		fs.rmSync(path.join(tmpRoot, entry), { recursive: true, force: true });
	}
});

describe("MtimeCache", () => {
	it("returns the same reference on a cache hit", () => {
		const cache = new MtimeCache<{ n: number }>();
		const fileA = path.join(tmpRoot, "a.txt");
		writeFile(fileA, "hello");

		let computes = 0;
		const compute = () => {
			computes++;
			return { value: { n: computes }, sources: { dirs: [tmpRoot], files: [fileA] } };
		};

		const first = cache.get("key", compute);
		const second = cache.get("key", compute);
		assert.equal(first, second);
		assert.equal(computes, 1);
		assert.equal(first.n, 1);
	});

	it("recomputes when a tracked file's mtime changes", () => {
		const cache = new MtimeCache<{ body: string }>();
		const fileA = path.join(tmpRoot, "a.txt");
		writeFile(fileA, "v1");

		let computes = 0;
		const compute = () => {
			computes++;
			const body = fs.readFileSync(fileA, "utf-8");
			return { value: { body }, sources: { dirs: [tmpRoot], files: [fileA] } };
		};

		assert.equal(cache.get("k", compute).body, "v1");
		assert.equal(computes, 1);

		writeFile(fileA, "v2");
		touchInFuture(fileA);
		assert.equal(cache.get("k", compute).body, "v2");
		assert.equal(computes, 2);
	});

	it("recomputes when a tracked directory's mtime changes", () => {
		const cache = new MtimeCache<string[]>();
		const dir = path.join(tmpRoot, "d");
		fs.mkdirSync(dir);

		let computes = 0;
		const compute = () => {
			computes++;
			const files = fs.readdirSync(dir).map((e) => path.join(dir, e));
			return { value: files, sources: { dirs: [dir], files } };
		};

		assert.deepEqual(cache.get("k", compute), []);
		assert.equal(computes, 1);

		// Adding a file bumps the dir's mtime.
		writeFile(path.join(dir, "new.md"), "body");
		touchInFuture(dir);
		const second = cache.get("k", compute);
		assert.equal(second.length, 1);
		assert.equal(computes, 2);
	});

	it("recomputes when a tracked file disappears", () => {
		const cache = new MtimeCache<{ n: number }>();
		const fileA = path.join(tmpRoot, "a.txt");
		writeFile(fileA, "body");

		let computes = 0;
		const compute = () => {
			computes++;
			return { value: { n: computes }, sources: { dirs: [tmpRoot], files: [fileA] } };
		};

		cache.get("k", compute);
		assert.equal(computes, 1);

		fs.unlinkSync(fileA);
		touchInFuture(tmpRoot); // make dir mtime advance too (defensive)
		cache.get("k", compute);
		assert.equal(computes, 2);
	});

	it("isolates entries by key", () => {
		const cache = new MtimeCache<string>();
		let computes = 0;
		const compute = (label: string) => () => {
			computes++;
			return { value: label, sources: { dirs: [], files: [] } };
		};
		assert.equal(cache.get("a", compute("A")), "A");
		assert.equal(cache.get("b", compute("B")), "B");
		assert.equal(cache.get("a", compute("A2")), "A"); // still cached
		assert.equal(computes, 2);
	});

	it("clear() drops all entries", () => {
		const cache = new MtimeCache<number>();
		let computes = 0;
		const compute = () => {
			computes++;
			return { value: computes, sources: { dirs: [], files: [] } };
		};
		cache.get("k", compute);
		cache.get("k", compute);
		assert.equal(computes, 1);

		cache.clear();
		cache.get("k", compute);
		assert.equal(computes, 2);
	});

	it("tolerates a missing file by recording mtime as null and recomputing on restore", () => {
		const cache = new MtimeCache<{ missing: boolean }>();
		const fileA = path.join(tmpRoot, "a.txt");
		// Initial compute: file does not exist yet.
		let computes = 0;
		const compute = () => {
			computes++;
			return {
				value: { missing: !fs.existsSync(fileA) },
				sources: { dirs: [tmpRoot], files: [fileA] },
			};
		};
		assert.equal(cache.get("k", compute).missing, true);
		assert.equal(computes, 1);

		// Repeat call with file still missing: cache hit.
		assert.equal(cache.get("k", compute).missing, true);
		assert.equal(computes, 1);

		// Now the file exists — its mtime changed from null to a number, must recompute.
		writeFile(fileA, "body");
		touchInFuture(fileA);
		assert.equal(cache.get("k", compute).missing, false);
		assert.equal(computes, 2);
	});
});
