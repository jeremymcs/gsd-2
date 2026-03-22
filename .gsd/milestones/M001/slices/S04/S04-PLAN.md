# S04: Custom Workflow Engine + Run Manager + Loop Integration

**Goal:** `CustomWorkflowEngine` and `CustomExecutionPolicy` implement the engine interfaces; `run-manager.ts` creates isolated run directories; the auto-loop dispatches custom workflow steps through the real pipeline.
**Demo:** An integration test dispatches a 3-step workflow definition through `autoLoop()` with mocked `LoopDeps`, and all 3 steps complete in dependency order with GRAPH.yaml reflecting the final state.

## Must-Haves

- `run-manager.ts` creates run directories with frozen DEFINITION.yaml + initialized GRAPH.yaml
- `CustomWorkflowEngine` derives state from GRAPH.yaml, resolves dispatch via `getNextPendingStep()`, and reconciles via `markStepComplete()` + `writeGraph()`
- `CustomExecutionPolicy` stubs all methods (verify returns `"continue"`, wired in S05)
- `engine-resolver.ts` routes non-dev engine IDs to the custom engine/policy pair
- `AutoSession` gains `activeRunDir: string | null` property (reset in `reset()`, serialized in `toJSON()`)
- `auto.ts` exports `setActiveRunDir()`/`getActiveRunDir()`
- `auto-dashboard.ts` handles `"custom-step"` unit type in `unitVerb()` and `unitPhaseLabel()`
- `auto/loop.ts` has a custom engine dispatch path parallel to the sidecar path
- Custom path skips `runPreDispatch` and `runDispatch`, uses `runGuards` and `runUnitPhase`, and bypasses `runFinalize` in favor of direct `engine.reconcile()` + `policy.verify()`
- All existing auto-mode tests pass unchanged

## Proof Level

- This slice proves: integration — custom workflow steps dispatch through the real auto-loop
- Real runtime required: no (mocked LoopDeps in integration test)
- Human/UAT required: no

## Verification

- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts` — all custom engine unit tests pass
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/run-manager.test.ts` — all run manager tests pass
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-engine-loop-integration.test.ts` — 3-step workflow dispatches through autoLoop
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-session-encapsulation.test.ts` — session encapsulation invariant holds
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/dev-engine-wrapper.test.ts` — dev engine tests still pass (regression)
- Failure-path diagnostic: `createRun()` with unknown definition throws an error containing the missing file path; `reconcile()` with invalid step ID throws; GRAPH.yaml preserves `active` status on mid-step failure for post-mortem inspection

## Observability / Diagnostics

- Runtime signals: `debugLog("autoLoop", { phase: "custom-engine-*" })` entries trace custom dispatch path; GRAPH.yaml on disk is human-readable step state
- Inspection surfaces: `cat .gsd/workflow-runs/<name>/<timestamp>/GRAPH.yaml` shows step statuses; `cat .gsd/workflow-runs/<name>/<timestamp>/DEFINITION.yaml` shows frozen definition
- Failure visibility: GRAPH.yaml shows which step was `active` when a failure occurred; `s.toJSON()` includes `activeRunDir` for diagnostics
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: `workflow-engine.ts` (`WorkflowEngine` interface), `execution-policy.ts` (`ExecutionPolicy` interface), `engine-types.ts` (all type contracts), `graph.ts` (read/write/query/mark), `definition-loader.ts` (load/validate/substitute), `engine-resolver.ts` (routing), `auto/session.ts` (`AutoSession`), `auto/loop.ts` (main loop), `auto/phases.ts` (phase functions)
- New wiring introduced in this slice: custom engine dispatch path in `auto/loop.ts`; `resolveEngine()` gains custom branch; `AutoSession.activeRunDir` state property
- What remains before the milestone is truly usable end-to-end: S05 (verification + context injection + params), S06 (iterate), S07 (CLI surface + dashboard), S08 (skill + examples), S09 (end-to-end test)

## Tasks

- [x] **T01: Implement run-manager, CustomWorkflowEngine, and CustomExecutionPolicy** `est:45m`
  - Why: Creates the three new pure modules that S04 depends on — the run directory manager, the custom engine implementing `WorkflowEngine`, and the stub execution policy. These have no loop dependencies and are independently testable.
  - Files: `src/resources/extensions/gsd/run-manager.ts`, `src/resources/extensions/gsd/custom-workflow-engine.ts`, `src/resources/extensions/gsd/custom-execution-policy.ts`, `src/resources/extensions/gsd/tests/run-manager.test.ts`, `src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts`
  - Do: Build `run-manager.ts` with `createRun(basePath, defName, overrides?)` and `listRuns(basePath, defName?)`. Build `CustomWorkflowEngine` implementing `WorkflowEngine` — `deriveState()` reads GRAPH.yaml, `resolveDispatch()` calls `getNextPendingStep()`, `reconcile()` calls `markStepComplete()` + `writeGraph()`, `getDisplayMetadata()` returns step N/M progress. Build `CustomExecutionPolicy` implementing `ExecutionPolicy` with all methods stubbed. Write comprehensive unit tests for all three. Use `.js` extension on all relative imports. Run directory convention: `.gsd/workflow-runs/<name>/<timestamp>/` with DEFINITION.yaml, GRAPH.yaml, optional PARAMS.json.
  - Verify: `node --experimental-strip-types --test src/resources/extensions/gsd/tests/run-manager.test.ts && node --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts`
  - Done when: All unit tests pass; `createRun()` creates correct directory structure; `CustomWorkflowEngine.deriveState()` → `resolveDispatch()` → `reconcile()` lifecycle works against a real temp directory; `CustomExecutionPolicy.verify()` returns `"continue"`

- [ ] **T02: Wire engine resolver, session, auto.ts exports, and dashboard for custom engine** `est:25m`
  - Why: Connects the pure modules from T01 into the existing infrastructure — resolver can return custom engine, session tracks the active run directory, auto.ts exposes the new state, and the dashboard renders custom-step units.
  - Files: `src/resources/extensions/gsd/engine-resolver.ts`, `src/resources/extensions/gsd/auto/session.ts`, `src/resources/extensions/gsd/auto.ts`, `src/resources/extensions/gsd/auto-dashboard.ts`
  - Do: Add custom engine branch to `resolveEngine()` that accepts `{ activeEngineId, activeRunDir }` and returns `CustomWorkflowEngine(activeRunDir)` + `CustomExecutionPolicy()` for any non-null, non-"dev" engine ID. Add `activeRunDir: string | null = null` to `AutoSession` (in properties, `reset()`, and `toJSON()`). Add `setActiveRunDir()`/`getActiveRunDir()` exports to `auto.ts`. Add `"custom-step"` cases to `unitVerb()` ("executing workflow step") and `unitPhaseLabel()` ("WORKFLOW") in `auto-dashboard.ts`. Maintain all `.js` import extensions.
  - Verify: `node --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-session-encapsulation.test.ts && node --experimental-strip-types --test src/resources/extensions/gsd/tests/dev-engine-wrapper.test.ts`
  - Done when: Session encapsulation test passes (no new module-level vars in auto.ts); dev engine wrapper tests pass unchanged (no regression); `resolveEngine({ activeEngineId: "custom", activeRunDir: "/tmp/x" })` returns a `CustomWorkflowEngine`/`CustomExecutionPolicy` pair

- [ ] **T03: Integrate custom engine dispatch path into autoLoop** `est:1h`
  - Why: The integration keystone — makes `autoLoop()` polymorphic. When `s.activeEngineId` is set to a non-dev value, the loop uses the custom engine's `deriveState()` → `resolveDispatch()` to determine what to execute, flows through shared `runGuards` → `runUnitPhase`, then calls `engine.reconcile()` + `policy.verify()` instead of `runFinalize`. This is the highest-risk change in S04.
  - Files: `src/resources/extensions/gsd/auto/loop.ts`, `src/resources/extensions/gsd/auto/phases.ts`, `src/resources/extensions/gsd/tests/custom-engine-loop-integration.test.ts`
  - Do: In `autoLoop()`, add a custom engine path after sidecar dequeue and before the normal dev path. When `s.activeEngineId` is non-null and not `"dev"`, resolve the engine via `resolveEngine()`, call `engine.deriveState()`, check for completion (`isComplete` → stop), call `engine.resolveDispatch()`, build `iterData` from the dispatch action, then flow through `runGuards` → `runUnitPhase`. After `runUnitPhase`, call `engine.reconcile()` and `policy.verify()` directly instead of `runFinalize`. In `auto/phases.ts`, the `custom-step` unit type already naturally bypasses worktree health check and zero-tool-call guard (both gated on `unitType === "execute-task"`). For artifact verification in `runUnitPhase`, treat `custom-step` like hook units — skip `verifyExpectedArtifact` and add to `completedUnits` unconditionally. Write integration test that creates a 3-step definition (A → B → C), creates a run, mocks LoopDeps, and runs autoLoop — verify GRAPH.yaml shows all 3 steps complete.
  - Verify: `node --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-engine-loop-integration.test.ts && node --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-loop.test.ts`
  - Done when: Integration test passes — 3-step workflow dispatches in dependency order through autoLoop, GRAPH.yaml shows all steps complete; existing auto-loop tests pass unchanged

## Files Likely Touched

- `src/resources/extensions/gsd/run-manager.ts` (new)
- `src/resources/extensions/gsd/custom-workflow-engine.ts` (new)
- `src/resources/extensions/gsd/custom-execution-policy.ts` (new)
- `src/resources/extensions/gsd/engine-resolver.ts` (modified)
- `src/resources/extensions/gsd/auto/session.ts` (modified)
- `src/resources/extensions/gsd/auto.ts` (modified)
- `src/resources/extensions/gsd/auto-dashboard.ts` (modified)
- `src/resources/extensions/gsd/auto/loop.ts` (modified)
- `src/resources/extensions/gsd/auto/phases.ts` (modified)
- `src/resources/extensions/gsd/tests/run-manager.test.ts` (new)
- `src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts` (new)
- `src/resources/extensions/gsd/tests/custom-engine-loop-integration.test.ts` (new)
