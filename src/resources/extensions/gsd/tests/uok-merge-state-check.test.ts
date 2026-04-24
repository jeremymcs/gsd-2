import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { closeDatabase, openDatabase, _getAdapter } from "../gsd-db.ts";
import { UokGateRunner } from "../uok/gate-runner.ts";
import {
  buildMergeStateGate,
  MERGE_STATE_GATE_ID,
  MERGE_STATE_RECONCILED_RATIONALE,
  translateGateResultToMergeReconcile,
} from "../uok/merge-state-gate.ts";
import { resolveUokFlags } from "../uok/flags.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gsdDir = join(__dirname, "..");

function makeGitBase(): string {
  const base = join(tmpdir(), `gsd-uok-mergegate-${randomUUID()}`);
  mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "tag.gpgsign", "false"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: base, stdio: "ignore" });
  return base;
}

function cleanup(base: string): void {
  try { rmSync(base, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function makeMockCtx(): { ctx: any; notifications: Array<{ msg: string; level: string }> } {
  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = { ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); } } };
  return { ctx, notifications };
}

test.beforeEach(() => {
  closeDatabase();
  const ok = openDatabase(":memory:");
  assert.equal(ok, true);
});

test.afterEach(() => {
  closeDatabase();
});

test("merge-state-check gate passes on a clean repo", async (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  const { ctx, notifications } = makeMockCtx();
  const runner = new UokGateRunner();
  runner.register(buildMergeStateGate(ctx));

  const result = await runner.run(MERGE_STATE_GATE_ID, {
    basePath: base,
    traceId: "trace-clean",
    turnId: "turn-clean",
  });

  assert.equal(result.outcome, "pass");
  assert.equal(result.failureClass, "none");
  assert.equal(result.rationale, undefined);
  assert.equal(translateGateResultToMergeReconcile(result), "clean");
  assert.equal(notifications.length, 0, "clean repo should not notify");

  const adapter = _getAdapter();
  const rows = adapter?.prepare("SELECT gate_id, outcome, failure_class FROM gate_runs").all() ?? [];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.["gate_id"], MERGE_STATE_GATE_ID);
  assert.equal(rows[0]?.["outcome"], "pass");
});

test("merge-state-check gate yields manual-attention on unresolved code conflicts", async (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  writeFileSync(join(base, "conflict.txt"), "base\n");
  execFileSync("git", ["add", "conflict.txt"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add conflict base"], { cwd: base, stdio: "ignore" });

  execFileSync("git", ["checkout", "-b", "feature"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "conflict.txt"), "feature\n");
  execFileSync("git", ["add", "conflict.txt"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feature change"], { cwd: base, stdio: "ignore" });

  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, "conflict.txt"), "main\n");
  execFileSync("git", ["add", "conflict.txt"], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "main change"], { cwd: base, stdio: "ignore" });

  try { execFileSync("git", ["merge", "--no-ff", "feature"], { cwd: base, stdio: "ignore" }); } catch { /* expected conflict */ }

  const { ctx } = makeMockCtx();
  const runner = new UokGateRunner();
  runner.register(buildMergeStateGate(ctx));

  const result = await runner.run(MERGE_STATE_GATE_ID, {
    basePath: base,
    traceId: "trace-blocked",
    turnId: "turn-blocked",
    milestoneId: "M001",
  });

  assert.equal(result.outcome, "manual-attention");
  assert.equal(result.failureClass, "git");
  assert.equal(result.rationale, "merge state blocked");
  assert.ok(result.findings && result.findings.includes("conflict.txt"), "findings should list conflicting file");
  assert.equal(translateGateResultToMergeReconcile(result), "blocked");

  // Gate runner retries `git` failures once per RETRY_MATRIX, so two rows are persisted:
  // attempt=1 outcome=retry, attempt=2 outcome=manual-attention. Assert on the final row.
  const adapter = _getAdapter();
  const rows = adapter?.prepare("SELECT outcome, failure_class, milestone_id, attempt FROM gate_runs WHERE gate_id = ? ORDER BY id").all(MERGE_STATE_GATE_ID) ?? [];
  assert.ok(rows.length >= 1, "gate run should persist at least one row");
  const finalRow = rows[rows.length - 1] as { outcome: string; failure_class: string; milestone_id: string };
  assert.equal(finalRow.outcome, "manual-attention");
  assert.equal(finalRow.failure_class, "git");
  assert.equal(finalRow.milestone_id, "M001");
});

test("merge-state-check gate passes with reconciled rationale on auto-resolved .gsd/ conflicts", async (t) => {
  const base = makeGitBase();
  t.after(() => cleanup(base));

  // Establish a .gsd/ file on main, then diverge it on a feature branch.
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "state.json"), '{"v":0}\n');
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "add .gsd state"], { cwd: base, stdio: "ignore" });

  execFileSync("git", ["checkout", "-b", "feature"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gsd", "state.json"), '{"v":1,"branch":"feature"}\n');
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "feature .gsd update"], { cwd: base, stdio: "ignore" });

  execFileSync("git", ["checkout", "main"], { cwd: base, stdio: "ignore" });
  writeFileSync(join(base, ".gsd", "state.json"), '{"v":1,"branch":"main"}\n');
  execFileSync("git", ["add", "."], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "main .gsd update"], { cwd: base, stdio: "ignore" });

  try { execFileSync("git", ["merge", "--no-ff", "feature"], { cwd: base, stdio: "ignore" }); } catch { /* expected conflict on .gsd/state.json */ }

  const { ctx } = makeMockCtx();
  const runner = new UokGateRunner();
  runner.register(buildMergeStateGate(ctx));

  const result = await runner.run(MERGE_STATE_GATE_ID, {
    basePath: base,
    traceId: "trace-reconciled",
    turnId: "turn-reconciled",
  });

  assert.equal(result.outcome, "pass");
  assert.equal(result.failureClass, "none");
  assert.equal(result.rationale, MERGE_STATE_RECONCILED_RATIONALE);
  assert.equal(translateGateResultToMergeReconcile(result), "reconciled");
});

test("resolveUokFlags exposes mergeStateChecks and respects opt-out", () => {
  assert.equal(resolveUokFlags(undefined).mergeStateChecks, true, "default is true");
  assert.equal(
    resolveUokFlags({ uok: { merge_state_checks: { enabled: false } } } as any).mergeStateChecks,
    false,
    "explicit opt-out flips the flag",
  );
});

test("auto.ts gates runMergeStateGate on uok.gates + uok.merge_state_checks before invoking the gate runner", () => {
  const source = readFileSync(join(gsdDir, "auto.ts"), "utf-8");
  assert.ok(
    source.includes("runMergeStateGate") && source.includes("liveUokFlags.mergeStateChecks"),
    "auto.ts should branch on liveUokFlags.mergeStateChecks before constructing the gate runner",
  );
  assert.ok(
    source.includes("buildMergeStateGate(ctx)") && source.includes("MERGE_STATE_GATE_ID"),
    "auto.ts should register buildMergeStateGate(ctx) and run it via MERGE_STATE_GATE_ID",
  );
});
