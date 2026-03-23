---
estimated_steps: 5
estimated_files: 2
skills_used: []
---

# T01: Add schema v9 migration with sequence column and fix ORDER BY queries

**Slice:** S04 — Hot-path caller migration + cross-validation tests
**Milestone:** M001

## Description

Add a `sequence INTEGER DEFAULT 0` column to the `slices` and `tasks` tables via a schema v9 migration block. Update all six `ORDER BY id` queries in gsd-db.ts to `ORDER BY sequence, id` so rows sort by explicit sequence first, falling back to lexicographic id when sequence is 0 or equal. Update the `SliceRow` and `TaskRow` TypeScript interfaces to include the new field. Write a test file proving the migration works and ordering respects sequence.

## Steps

1. In `src/resources/extensions/gsd/gsd-db.ts`, bump `SCHEMA_VERSION` from 8 to 9.
2. Add a `currentVersion < 9` migration block after the v8 block. Use `ensureColumn()` to add `sequence INTEGER DEFAULT 0` to both `slices` and `tasks` tables. Insert schema_version row for version 9.
3. Add `sequence: number` to both `SliceRow` and `TaskRow` interfaces.
4. Update all 6 `ORDER BY id` queries to `ORDER BY sequence, id`:
   - `getSliceTasks()` (line ~1245): `ORDER BY sequence, id`
   - `getAllMilestones()` (line ~1341): keep `ORDER BY id` (milestones don't have sequence)
   - `getActiveMilestoneFromDb()` (line ~1355): keep `ORDER BY id`
   - `getActiveSliceFromDb()` (line ~1364): `ORDER BY sequence, id`
   - `getActiveTaskFromDb()` (line ~1385): `ORDER BY sequence, id`
   - `getMilestoneSlices()` (line ~1393): `ORDER BY sequence, id`
5. Write `src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts` with tests:
   - Migration adds `sequence` column to both tables
   - `getMilestoneSlices()` returns slices ordered by sequence then id
   - `getSliceTasks()` returns tasks ordered by sequence then id
   - Default sequence (0) falls back to id-based ordering
   - `insertSlice` / `insertTask` accept the sequence field

## Must-Haves

- [ ] `SCHEMA_VERSION` is 9
- [ ] `sequence INTEGER DEFAULT 0` exists on both `slices` and `tasks` tables after migration
- [ ] `SliceRow` and `TaskRow` interfaces include `sequence: number`
- [ ] All slice/task queries use `ORDER BY sequence, id`
- [ ] Test file passes under resolver harness

## Verification

- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/plan-milestone.test.ts src/resources/extensions/gsd/tests/plan-slice.test.ts src/resources/extensions/gsd/tests/plan-task.test.ts` (no regressions)

## Inputs

- `src/resources/extensions/gsd/gsd-db.ts` — current schema v8 migration, query functions, SliceRow/TaskRow interfaces
- `src/resources/extensions/gsd/tests/resolve-ts.mjs` — test resolver harness

## Expected Output

- `src/resources/extensions/gsd/gsd-db.ts` — updated with schema v9, sequence field, ORDER BY changes
- `src/resources/extensions/gsd/tests/schema-v9-sequence.test.ts` — new test file proving sequence ordering

## Observability Impact

- **Schema version**: `SCHEMA_VERSION` constant changes from 8 → 9; `schema_version` table gains a row for version 9 with timestamp
- **Column visibility**: `PRAGMA table_info(slices)` and `PRAGMA table_info(tasks)` now show `sequence INTEGER DEFAULT 0`
- **Query ordering**: All slice/task list queries sort by `sequence, id` — inspectable via `EXPLAIN QUERY PLAN` or by inserting rows with non-lexicographic sequence values
- **Failure state**: `getMilestoneSlices('NONEXISTENT')` returns `[]` (empty array, no crash); `getSliceTasks` with no DB open returns `[]`
- **Interface change**: `SliceRow.sequence` and `TaskRow.sequence` fields available to all downstream consumers
