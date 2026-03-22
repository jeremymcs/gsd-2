---
estimated_steps: 5
estimated_files: 5
skills_used: []
---

# T01: Implement run-manager, CustomWorkflowEngine, and CustomExecutionPolicy

**Slice:** S04 — Custom Workflow Engine + Run Manager + Loop Integration
**Milestone:** M001

## Description

Create the three new pure modules that form the foundation of S04. These have no auto-loop dependencies and are independently testable with temp directories:

1. **`run-manager.ts`** — Creates isolated run directories under `.gsd/workflow-runs/<name>/<timestamp>/` containing a frozen `DEFINITION.yaml` snapshot and an initialized `GRAPH.yaml`. Optionally writes `PARAMS.json` when overrides are provided. Also provides `listRuns()` to enumerate existing runs.

2. **`custom-workflow-engine.ts`** — Implements `WorkflowEngine` interface. Constructor takes `runDir: string`. `deriveState()` reads GRAPH.yaml and returns engine state with phase/step counts. `resolveDispatch()` calls `getNextPendingStep()` — returns dispatch with `unitType: "custom-step"` and `unitId: "<workflowName>/<stepId>"`, or stop when all complete. `reconcile()` calls `markStepComplete()` + `writeGraph()`. `getDisplayMetadata()` returns step N/M progress with `engineLabel: "WORKFLOW"`.

3. **`custom-execution-policy.ts`** — Implements `ExecutionPolicy` interface with all methods stubbed. `verify()` returns `"continue"`. Other methods are no-ops or return neutral values. This stub is wired properly in S05.

## Steps

1. Create `src/resources/extensions/gsd/run-manager.ts`:
   - `createRun(basePath: string, defName: string, overrides?: Record<string, string>)` — loads definition from `.gsd/workflow-defs/<defName>.yaml`, substitutes params if overrides provided, freezes DEFINITION.yaml into run dir, initializes GRAPH.yaml via `initializeGraph()`, writes PARAMS.json if overrides present. Timestamp format for dir name: `YYYY-MM-DDTHH-MM-SS` (replace colons with hyphens for filesystem safety). Returns the run directory path.
   - `listRuns(basePath: string, defName?: string)` — scans `.gsd/workflow-runs/` and returns metadata (name, timestamp, step counts, status derived from GRAPH.yaml).
   - Import `loadDefinition`, `substituteParams` from `./definition-loader.js`, `initializeGraph`, `writeGraph`, `readGraph` from `./graph.js`, plus `node:fs` and `node:path`. Use `yaml` package `stringify` for DEFINITION.yaml.

2. Create `src/resources/extensions/gsd/custom-workflow-engine.ts`:
   - Class `CustomWorkflowEngine` implements `WorkflowEngine`.
   - `readonly engineId = "custom"`.
   - Constructor accepts `runDir: string`, stores as private field.
   - `deriveState(basePath)`: reads GRAPH.yaml from `this.runDir`, computes phase (`"running"` if any pending/active, `"complete"` if all complete/expanded), returns `EngineState` with `isComplete`, `raw: graph`.
   - `resolveDispatch(state)`: calls `getNextPendingStep()` on graph from `state.raw`. Returns `{ action: "dispatch", step: { unitType: "custom-step", unitId: "<name>/<stepId>", prompt: step.prompt } }` or `{ action: "stop", reason: "All steps complete", level: "info" }`.
   - `reconcile(state, completedStep)`: extracts stepId from `completedStep.unitId` (split on `/`, take last), calls `markStepComplete()` on graph, calls `writeGraph()` to persist. Returns `{ outcome: "continue" }` unless all steps are now complete → `{ outcome: "milestone-complete" }`.
   - `getDisplayMetadata(state)`: counts completed vs total steps from graph, returns `DisplayMetadata` with `engineLabel: "WORKFLOW"`, `currentPhase`, `progressSummary: "Step N/M"`, `stepCount`.
   - Imports: `./workflow-engine.js`, `./engine-types.js`, `./graph.js`.

3. Create `src/resources/extensions/gsd/custom-execution-policy.ts`:
   - Class `CustomExecutionPolicy` implements `ExecutionPolicy`.
   - `prepareWorkspace()`: no-op (returns resolved promise).
   - `selectModel()`: returns `null` (use defaults).
   - `verify()`: returns `"continue"`.
   - `recover()`: returns `{ outcome: "retry", reason: "Default retry" }`.
   - `closeout()`: returns `{ committed: false, artifacts: [] }`.
   - Imports: `./execution-policy.js`, `./engine-types.js`.

4. Create `src/resources/extensions/gsd/tests/run-manager.test.ts`:
   - Test `createRun()` creates directory structure with DEFINITION.yaml and GRAPH.yaml.
   - Test `createRun()` with overrides writes PARAMS.json and substituted prompts.
   - Test `createRun()` with unknown definition throws.
   - Test `listRuns()` returns correct metadata.
   - Test `listRuns()` with filter returns only matching definition name.
   - Use `node:test` + `node:assert/strict`. Create temp dirs with `mkdtempSync`. Write test definition YAML files to temp `.gsd/workflow-defs/`.

5. Create `src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts`:
   - Test `deriveState()` reads GRAPH.yaml and returns correct phase/step counts.
   - Test `resolveDispatch()` returns dispatch for first pending step.
   - Test `resolveDispatch()` returns stop when all complete.
   - Test `resolveDispatch()` respects dependency ordering.
   - Test `reconcile()` marks step complete in GRAPH.yaml on disk.
   - Test `reconcile()` returns `milestone-complete` when all steps done.
   - Test `getDisplayMetadata()` returns correct progress summary.
   - Test `CustomExecutionPolicy.verify()` returns `"continue"`.
   - Use real temp directories with actual GRAPH.yaml files (not mocks).

## Must-Haves

- [ ] `createRun()` creates `.gsd/workflow-runs/<name>/<timestamp>/` with DEFINITION.yaml, GRAPH.yaml, and optional PARAMS.json
- [ ] `CustomWorkflowEngine` implements full `WorkflowEngine` interface using GRAPH.yaml
- [ ] `CustomExecutionPolicy` implements full `ExecutionPolicy` interface with stubs
- [ ] Unit type is `"custom-step"` and unit ID format is `"<workflowName>/<stepId>"`
- [ ] All relative imports use `.js` extension (ESM convention)
- [ ] All tests pass

## Verification

- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/run-manager.test.ts` — all run manager tests pass
- `node --experimental-strip-types --test src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts` — all custom engine tests pass

## Inputs

- `src/resources/extensions/gsd/workflow-engine.ts` — `WorkflowEngine` interface to implement
- `src/resources/extensions/gsd/execution-policy.ts` — `ExecutionPolicy` interface to implement
- `src/resources/extensions/gsd/engine-types.ts` — `EngineState`, `EngineDispatchAction`, `ReconcileResult`, `DisplayMetadata`, `CompletedStep`, `RecoveryAction`, `CloseoutResult` types
- `src/resources/extensions/gsd/graph.ts` — `readGraph`, `writeGraph`, `getNextPendingStep`, `markStepComplete`, `initializeGraph`, `WorkflowGraph`, `GraphStep` types
- `src/resources/extensions/gsd/definition-loader.ts` — `loadDefinition`, `substituteParams`, `WorkflowDefinition` types

## Expected Output

- `src/resources/extensions/gsd/run-manager.ts` — run directory creation and listing
- `src/resources/extensions/gsd/custom-workflow-engine.ts` — custom engine implementing WorkflowEngine
- `src/resources/extensions/gsd/custom-execution-policy.ts` — stub execution policy
- `src/resources/extensions/gsd/tests/run-manager.test.ts` — run manager unit tests
- `src/resources/extensions/gsd/tests/custom-workflow-engine.test.ts` — custom engine + policy unit tests

## Observability Impact

- **New inspection surfaces:** `cat .gsd/workflow-runs/<name>/<timestamp>/GRAPH.yaml` shows step statuses; `cat .gsd/workflow-runs/<name>/<timestamp>/DEFINITION.yaml` shows the frozen definition used at run creation; `cat .gsd/workflow-runs/<name>/<timestamp>/PARAMS.json` shows parameter overrides.
- **Failure visibility:** `createRun()` errors include the full definition file path. `reconcile()` throws with step ID when a step is not found. GRAPH.yaml retains per-step `status` and `finishedAt` timestamps — if a run fails mid-execution, the graph shows which step was last active.
- **Future agent inspection:** `listRuns()` returns structured metadata (step counts, overall status) for any agent to query programmatically. `getDisplayMetadata()` provides standardized progress ("Step N/M") that downstream dashboards consume.
