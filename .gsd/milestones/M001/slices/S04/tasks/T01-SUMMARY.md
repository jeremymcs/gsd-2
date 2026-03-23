---
id: T01
parent: S04
milestone: M001
key_files:
  - src/resources/extensions/gsd/gsd-db.ts
  - src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts
  - .gsd/milestones/M001/slices/S04/S04-PLAN.md
  - .gsd/milestones/M001/slices/S04/tasks/T01-PLAN.md
key_decisions:
  - Added sequence column to initial CREATE TABLE DDL in addition to migration block — required for fresh databases that skip migrations
  - Used INTEGER DEFAULT 0 (not NOT NULL) for sequence column to keep it nullable-safe and backward compatible
duration: ""
verification_result: passed
completed_at: 2026-03-23T16:57:23.834Z
blocker_discovered: false
---

# T01: Add schema v9 migration with sequence column on slices/tasks tables and fix ORDER BY queries to use sequence, id

**Add schema v9 migration with sequence column on slices/tasks tables and fix ORDER BY queries to use sequence, id**

## What Happened

Added a `sequence INTEGER DEFAULT 0` column to both `slices` and `tasks` tables via two changes: (1) updated the initial CREATE TABLE definitions so fresh databases include the column from the start, and (2) added a `currentVersion < 9` migration block using `ensureColumn()` for existing databases upgrading from v8. Bumped `SCHEMA_VERSION` from 8 to 9.

Updated both `SliceRow` and `TaskRow` TypeScript interfaces to include `sequence: number`, and updated their `rowToSlice`/`rowToTask` converter functions to read the field with a `?? 0` fallback.

Updated all 4 slice/task `ORDER BY id` queries to `ORDER BY sequence, id`: `getSliceTasks()`, `getActiveSliceFromDb()`, `getActiveTaskFromDb()`, and `getMilestoneSlices()`. Left the 2 milestone queries (`getAllMilestones`, `getActiveMilestoneFromDb`) using `ORDER BY id` as milestones don't have a sequence column.

Updated `insertSlice` and `insertTask` to accept an optional `sequence` parameter, defaulting to 0.

Wrote 7 tests covering: migration adds columns, sequence-based ordering for slices and tasks, default sequence=0 falls back to id ordering, `getActiveSliceFromDb` and `getActiveTaskFromDb` respect sequence, and sequence defaults to 0 when not provided.

Also addressed the pre-flight observability gaps: added a diagnostic verification step to S04-PLAN.md and an Observability Impact section to T01-PLAN.md.

## Verification

Ran schema-v9-sequence test suite: 7/7 pass. Ran plan-milestone, plan-slice, plan-task regression tests: 15/15 pass. Verified SCHEMA_VERSION=9. Verified all 4 slice/task ORDER BY queries use `sequence, id`. Verified milestone ORDER BY queries remain `ORDER BY id`.

## Verification Evidence

| # | Command | Exit Code | Verdict | Duration |
|---|---------|-----------|---------|----------|
| 1 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts` | 0 | ✅ pass | 203ms |
| 2 | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/plan-milestone.test.ts src/resources/extensions/gsd/tests/plan-slice.test.ts src/resources/extensions/gsd/tests/plan-task.test.ts` | 0 | ✅ pass | 207ms |


## Deviations

Added `sequence INTEGER DEFAULT 0` to the initial CREATE TABLE definitions for slices and tasks (not just the migration block). This was necessary because fresh databases created via `openDatabase` use the CREATE TABLE DDL directly — the migration block only runs for existing DBs upgrading from a prior version. Without this, insertSlice/insertTask would fail on fresh DBs because the column wouldn't exist.

## Known Issues

None.

## Files Created/Modified

- `src/resources/extensions/gsd/gsd-db.ts`
- `src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts`
- `.gsd/milestones/M001/slices/S04/S04-PLAN.md`
- `.gsd/milestones/M001/slices/S04/tasks/T01-PLAN.md`
