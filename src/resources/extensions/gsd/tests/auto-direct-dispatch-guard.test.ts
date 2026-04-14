// GSD Extension — Dependency guard for /gsd <phase> direct dispatch.
//
// Regression guard for the Codex adversarial review on PR #4198: before this
// test, dispatchDirectPhase skipped the prior-slice dependency gate that auto
// dispatch applies via getPriorSliceCompletionBlocker. With the stale-dep
// fallback opt-in, state could surface an active slice whose deps were not
// satisfied, and direct dispatch would happily send it through.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { dispatchDirectPhase } from "../auto-direct-dispatch.ts";
import { invalidateStateCache } from "../state.ts";

function createFixture(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-direct-dispatch-guard-"));

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-CONTEXT.md"),
    "# M001: Test Milestone\n\nContext.\n",
  );

  // S01 is pending, S02 depends on S01 but is selected via GSD_SLICE_LOCK.
  // The dispatch guard must catch the unmet dep even though state.ts resolves
  // to S02 because of the lock.
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [ ] **S01: First** `risk:low` `depends:[]`",
      "- [ ] **S02: Second** `risk:low` `depends:[S01]`",
      "",
    ].join("\n"),
  );

  const s01Dir = join(milestoneDir, "slices", "S01");
  mkdirSync(s01Dir, { recursive: true });
  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    "# S01 Plan\n\n## Tasks\n\n- [ ] **T01: Work** `effort:low`\n",
  );
  const s01Task = join(s01Dir, "tasks", "T01");
  mkdirSync(s01Task, { recursive: true });
  writeFileSync(join(s01Task, "T01-PLAN.md"), "# T01 Plan\n");

  const s02Dir = join(milestoneDir, "slices", "S02");
  mkdirSync(s02Dir, { recursive: true });
  writeFileSync(
    join(s02Dir, "S02-PLAN.md"),
    "# S02 Plan\n\n## Tasks\n\n- [ ] **T01: Work** `effort:low`\n",
  );
  const s02Task = join(s02Dir, "tasks", "T01");
  mkdirSync(s02Task, { recursive: true });
  writeFileSync(join(s02Task, "T01-PLAN.md"), "# T01 Plan\n");

  return base;
}

test("dispatchDirectPhase blocks plan-slice when dependency slice is incomplete", async (t) => {
  const base = createFixture();
  const origLock = process.env.GSD_SLICE_LOCK;
  // Force state.ts to surface S02 even though its dep S01 is pending.
  process.env.GSD_SLICE_LOCK = "S02";
  invalidateStateCache();

  const notifications: { message: string; level: string }[] = [];
  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    newSession: async () => ({ cancelled: false }),
  } as any;

  const pi = {
    sendMessage: () => {
      assert.fail("sendMessage must NOT be called when the dep guard blocks dispatch");
    },
  } as any;

  t.after(() => {
    if (origLock !== undefined) process.env.GSD_SLICE_LOCK = origLock;
    else delete process.env.GSD_SLICE_LOCK;
    invalidateStateCache();
    rmSync(base, { recursive: true, force: true });
  });

  await dispatchDirectPhase(ctx, pi, "plan", base);

  const warning = notifications.find(n =>
    n.level === "warning" && /dependency slice M001\/S01/i.test(n.message),
  );
  assert.ok(
    warning,
    `expected a warning notification about the unmet dependency on M001/S01 (got: ${JSON.stringify(notifications)})`,
  );
});

test("dispatchDirectPhase allows plan-slice when dependency slice is complete", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-direct-dispatch-guard-ok-"));
  invalidateStateCache();

  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });

  writeFileSync(
    join(milestoneDir, "M001-CONTEXT.md"),
    "# M001: Test Milestone\n\nContext.\n",
  );

  // S01 done, S02 depends on S01 and is the natural active slice.
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Slices",
      "",
      "- [x] **S01: Done** `risk:low` `depends:[]`",
      "- [ ] **S02: Active** `risk:low` `depends:[S01]`",
      "",
    ].join("\n"),
  );

  const s01Dir = join(milestoneDir, "slices", "S01");
  mkdirSync(s01Dir, { recursive: true });
  writeFileSync(
    join(s01Dir, "S01-PLAN.md"),
    "# S01 Plan\n\n## Tasks\n\n- [x] **T01: Done** `effort:low`\n",
  );
  const s01Task = join(s01Dir, "tasks", "T01");
  mkdirSync(s01Task, { recursive: true });
  writeFileSync(join(s01Task, "T01-PLAN.md"), "# T01 Plan\n");
  writeFileSync(join(s01Task, "T01-SUMMARY.md"), "# T01 Summary\n\nDone.\n");
  writeFileSync(join(s01Dir, "S01-SUMMARY.md"), "# S01 Summary\n\nDone.\n");

  const notifications: { message: string; level: string }[] = [];
  let sent = false;
  const ctx = {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    newSession: async () => ({ cancelled: false }),
  } as any;

  const pi = {
    sendMessage: () => {
      sent = true;
    },
  } as any;

  t.after(() => {
    invalidateStateCache();
    rmSync(base, { recursive: true, force: true });
  });

  await dispatchDirectPhase(ctx, pi, "plan", base);

  const depWarning = notifications.find(n =>
    n.level === "warning" && /dependency slice/i.test(n.message),
  );
  assert.equal(depWarning, undefined, `no dep-guard warning expected (got: ${JSON.stringify(notifications)})`);
  assert.ok(sent, "dispatch should succeed when all deps are satisfied");
});
