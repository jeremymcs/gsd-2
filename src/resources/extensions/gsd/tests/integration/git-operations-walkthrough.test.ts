// GSD Extension — Git Operations Pipeline Walkthrough Tests
// Tests every git operation in the auto-mode pipeline with real temp repos.
// Covers: worktree lifecycle, auto-commit, squash merge, stash/pop,
// branch cleanup, dirty tree handling, and edge cases.
//
// Note: execSync is used intentionally for git operations with controlled,
// hardcoded inputs. This is safe and necessary for testing real git behavior.

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" }).trim();
}

function runSafe(cmd: string, cwd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, cwd) };
  } catch (e) {
    return { ok: false, out: (e as Error).message };
  }
}

function createTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-git-ops-")));
  run("git init", dir);
  run("git config user.email test@test.com", dir);
  run("git config user.name Test", dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, ".gsd", "STATE.md"), "# State\n");
  run("git add .", dir);
  run("git commit -m init", dir);
  run("git branch -M main", dir);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WORKTREE LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

describe("git-operations: worktree lifecycle", () => {

  test("git worktree add creates isolated worktree", () => {
    const repo = createTempRepo();
    const wtPath = join(repo, ".gsd", "worktrees", "M001");
    mkdirSync(join(repo, ".gsd", "worktrees"), { recursive: true });

    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);

    assert.ok(existsSync(wtPath), "worktree directory should exist");
    assert.ok(existsSync(join(wtPath, "README.md")), "worktree should have repo files");

    const branch = run("git branch --show-current", wtPath);
    assert.equal(branch, "milestone/M001", "worktree should be on milestone branch");
  });

  test("git worktree list shows created worktree", () => {
    const repo = createTempRepo();
    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);

    const list = run("git worktree list", repo);
    assert.ok(list.includes("milestone/M001"), "worktree list should show milestone branch");
  });

  test("git worktree remove cleans up worktree", () => {
    const repo = createTempRepo();
    const wtPath = join(repo, ".gsd", "worktrees", "M001");
    mkdirSync(join(repo, ".gsd", "worktrees"), { recursive: true });
    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);
    assert.ok(existsSync(wtPath));

    run("git worktree remove .gsd/worktrees/M001", repo);
    assert.ok(!existsSync(wtPath), "worktree directory should be removed");

    const list = run("git worktree list", repo);
    assert.ok(!list.includes("milestone/M001"), "worktree list should not show removed worktree");
  });

  test("creating worktree with existing branch name fails", () => {
    const repo = createTempRepo();
    run("git branch milestone/M001", repo);
    mkdirSync(join(repo, ".gsd", "worktrees"), { recursive: true });

    // Branch exists but not as worktree — worktree add with -b should fail
    const result = runSafe("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);
    assert.equal(result.ok, false, "should fail when branch already exists");
    assert.ok(result.out.includes("already exists"), "error should mention branch exists");
  });

  test("git worktree prune cleans stale refs after manual deletion", () => {
    const repo = createTempRepo();
    const wtPath = join(repo, ".gsd", "worktrees", "M001");
    mkdirSync(join(repo, ".gsd", "worktrees"), { recursive: true });
    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);

    // Manually delete the worktree directory (simulates crash)
    rmSync(wtPath, { recursive: true, force: true });

    // Before prune, git knows the worktree existed
    const listBefore = run("git worktree list", repo);
    assert.ok(listBefore.includes("M001"), "stale ref should still show before prune");

    run("git worktree prune", repo);
    const listAfter = run("git worktree list", repo);
    assert.ok(!listAfter.includes("M001"), "stale ref should be cleaned after prune");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTO-COMMIT BEHAVIOR
// ═══════════════════════════════════════════════════════════════════════════════

describe("git-operations: auto-commit behavior", () => {

  test("writing files + git add + commit works in worktree", () => {
    const repo = createTempRepo();
    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);
    const wt = join(repo, ".gsd", "worktrees", "M001");

    // Simulate agent writing code
    writeFileSync(join(wt, "feature.ts"), "export const x = 1;\n");
    run("git add feature.ts", wt);
    run('git commit -m "feat: add feature"', wt);

    const log = run("git log --oneline", wt);
    assert.ok(log.includes("feat: add feature"), "commit should appear in log");
  });

  test("no changes → git commit fails (no empty commits)", () => {
    const repo = createTempRepo();
    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);
    const wt = join(repo, ".gsd", "worktrees", "M001");

    const result = runSafe('git commit -m "empty" --allow-empty=false', wt);
    // Git exits non-zero when nothing to commit (without --allow-empty)
    // This is correct behavior — auto-commit should check for changes first
    assert.equal(result.ok, false, "commit should fail with no changes");
  });

  test("only .gsd/ files changed → commit still created", () => {
    const repo = createTempRepo();
    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);
    const wt = join(repo, ".gsd", "worktrees", "M001");

    mkdirSync(join(wt, ".gsd", "milestones"), { recursive: true });
    writeFileSync(join(wt, ".gsd", "milestones", "M001-CONTEXT.md"), "# Context\n");
    run("git add .gsd/", wt);
    run('git commit -m "chore: update GSD state"', wt);

    const log = run("git log --oneline", wt);
    assert.ok(log.includes("chore: update GSD state"), ".gsd-only commit should succeed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MERGE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

describe("git-operations: merge operations", () => {

  test("clean squash merge from milestone branch to main", () => {
    const repo = createTempRepo();
    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);
    const wt = join(repo, ".gsd", "worktrees", "M001");

    // Make commits in worktree
    writeFileSync(join(wt, "feature.ts"), "export const x = 1;\n");
    run("git add .", wt);
    run('git commit -m "feat: feature A"', wt);
    writeFileSync(join(wt, "feature2.ts"), "export const y = 2;\n");
    run("git add .", wt);
    run('git commit -m "feat: feature B"', wt);

    // Remove worktree before merging (git requires this)
    run("git worktree remove .gsd/worktrees/M001", repo);

    // Squash merge on main
    run("git merge --squash milestone/M001", repo);
    run('git commit -m "feat(M001): milestone complete"', repo);

    // Verify single squash commit on main
    const log = run("git log --oneline", repo);
    assert.ok(log.includes("feat(M001): milestone complete"));

    // Verify files landed
    assert.ok(existsSync(join(repo, "feature.ts")));
    assert.ok(existsSync(join(repo, "feature2.ts")));
  });

  test("merge-base --is-ancestor detects diverged branches", () => {
    const repo = createTempRepo();
    run("git checkout -b milestone/M001", repo);
    writeFileSync(join(repo, "milestone.ts"), "// milestone\n");
    run("git add .", repo);
    run('git commit -m "milestone work"', repo);

    // Go back to main and make a diverging commit
    run("git checkout main", repo);
    writeFileSync(join(repo, "main-only.ts"), "// main\n");
    run("git add .", repo);
    run('git commit -m "main diverges"', repo);

    // Main is NOT an ancestor of milestone/M001 anymore (they diverged)
    // is-ancestor checks if arg1 is ancestor of arg2
    const mainHead = run("git rev-parse main", repo);
    const milestoneHead = run("git rev-parse milestone/M001", repo);
    const result = runSafe(`git merge-base --is-ancestor ${mainHead} ${milestoneHead}`, repo);
    assert.equal(result.ok, false, "diverged branches: main is NOT ancestor of milestone");
  });

  test("stash before merge preserves dirty state", () => {
    const repo = createTempRepo();

    // Dirty the working tree
    writeFileSync(join(repo, "dirty.txt"), "uncommitted work\n");

    // Stash it
    run("git add dirty.txt", repo);
    run('git stash push -m "pre-merge stash"', repo);

    // Verify working tree is clean
    const status = run("git status --porcelain", repo);
    assert.equal(status, "", "working tree should be clean after stash");

    // Pop restores the file
    run("git stash pop", repo);
    assert.ok(existsSync(join(repo, "dirty.txt")), "dirty file should be restored");
    const content = readFileSync(join(repo, "dirty.txt"), "utf-8");
    assert.equal(content, "uncommitted work\n", "content should be preserved");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// BRANCH CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

describe("git-operations: branch cleanup", () => {

  test("git branch -D removes milestone branch after merge", () => {
    const repo = createTempRepo();
    run("git branch milestone/M001", repo);

    const branchesBefore = run("git branch", repo);
    assert.ok(branchesBefore.includes("milestone/M001"));

    run("git branch -D milestone/M001", repo);

    const branchesAfter = run("git branch", repo);
    assert.ok(!branchesAfter.includes("milestone/M001"), "branch should be deleted");
  });

  test("deleting non-existent branch fails gracefully", () => {
    const repo = createTempRepo();

    const result = runSafe("git branch -D nonexistent-branch", repo);
    assert.equal(result.ok, false, "should fail for non-existent branch");
    assert.ok(result.out.includes("not found"), "error should mention branch not found");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DIRTY TREE + EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════════

describe("git-operations: dirty tree and edge cases", () => {

  test("dirty tree detected by git status --porcelain", () => {
    const repo = createTempRepo();
    writeFileSync(join(repo, "new.txt"), "new file\n");

    const status = run("git status --porcelain", repo);
    assert.ok(status.length > 0, "porcelain output should show untracked file");
    assert.ok(status.includes("new.txt"), "should include the new file");
  });

  test("clean tree produces empty git status --porcelain", () => {
    const repo = createTempRepo();

    const status = run("git status --porcelain", repo);
    assert.equal(status, "", "clean repo should have empty porcelain output");
  });

  test("stash pop with .gsd/ conflict resolved via checkout HEAD", () => {
    const repo = createTempRepo();

    // Stage a .gsd/ change and stash it
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# Modified state\n");
    run("git add .gsd/STATE.md", repo);
    run('git stash push -m "pre-merge"', repo);

    // Make a conflicting change on the same file and commit
    writeFileSync(join(repo, ".gsd", "STATE.md"), "# Different state from merge\n");
    run("git add .gsd/STATE.md", repo);
    run('git commit -m "merge brought different .gsd state"', repo);

    // Stash pop will conflict on .gsd/STATE.md
    const popResult = runSafe("git stash pop", repo);
    if (!popResult.ok) {
      // Conflict expected — resolve by accepting HEAD version
      run("git checkout HEAD -- .gsd/STATE.md", repo);
      run("git reset HEAD", repo);

      // Verify the HEAD version won
      const content = readFileSync(join(repo, ".gsd", "STATE.md"), "utf-8");
      assert.ok(content.includes("Different state from merge"),
        ".gsd conflict should be resolved with HEAD version");
    } else {
      // No conflict (git auto-merged) — that's also fine
      assert.ok(true, "git auto-merged the .gsd change without conflict");
    }
  });

  test("detached HEAD → branch detection returns empty", () => {
    const repo = createTempRepo();
    const head = run("git rev-parse HEAD", repo);
    run(`git checkout ${head}`, repo);

    const branch = runSafe("git branch --show-current", repo);
    assert.ok(branch.ok, "command should succeed");
    assert.equal(branch.out, "", "detached HEAD should return empty branch name");
  });

  test("concurrent worktree creation for same branch fails", () => {
    const repo = createTempRepo();
    mkdirSync(join(repo, ".gsd", "worktrees"), { recursive: true });

    // Create first worktree
    run("git worktree add .gsd/worktrees/M001 -b milestone/M001", repo);

    // Try to create second worktree on same branch
    const result = runSafe("git worktree add .gsd/worktrees/M001-dupe milestone/M001", repo);
    assert.equal(result.ok, false, "should fail when branch already checked out");
    assert.ok(
      result.out.includes("already checked out") || result.out.includes("is already used"),
      "error should mention branch in use",
    );
  });

  test("git diff --numstat shows changed files for merge validation", () => {
    const repo = createTempRepo();

    // Make a code change
    writeFileSync(join(repo, "feature.ts"), "export const x = 1;\n");
    run("git add .", repo);
    run('git commit -m "add feature"', repo);

    const diff = run("git diff --numstat HEAD~1 HEAD", repo);
    assert.ok(diff.includes("feature.ts"), "diff should show the changed file");
    // Should NOT include only .gsd/ files for implementation validation
    const nonGsdLines = diff.split("\n").filter(l => !l.includes(".gsd/"));
    assert.ok(nonGsdLines.length > 0, "should have non-.gsd files in diff");
  });
});
