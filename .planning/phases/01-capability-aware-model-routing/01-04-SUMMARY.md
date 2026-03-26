---
phase: 01-capability-aware-model-routing
plan: "04"
subsystem: model-routing
tags: [extension-api, model-routing, event-hooks, typescript]

# Dependency graph
requires:
  - phase: 01-01
    provides: capability scoring functions and types used downstream

provides:
  - BeforeModelSelectEvent interface (unitType, unitId, classification, taskMetadata, eligibleModels, phaseConfig fields)
  - BeforeModelSelectResult type ({ modelId: string })
  - on('before_model_select') subscription overload on ExtensionAPI
  - emitBeforeModelSelect() method on ExtensionAPI and ExtensionRuntimeState
  - ExtensionRunner.emitBeforeModelSelect() implementation via invokeHandlers (first-override-wins)
  - Runtime binding of emitBeforeModelSelect at ExtensionRunner construction time
  - GSD before_model_select placeholder handler registration in register-hooks.ts

affects:
  - 01-05 (wiring emitBeforeModelSelect call into selectAndApplyModel() execution path)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "First-override-wins: before_model_select uses done:true on first non-undefined handler result"
    - "Runtime delegation: ExtensionRunner binds own emit methods into shared runtime at construction time"
    - "Placeholder handler: GSD registers handler returning undefined to document intent before full wiring"

key-files:
  created: []
  modified:
    - packages/pi-coding-agent/src/core/extensions/types.ts
    - packages/pi-coding-agent/src/core/extensions/runner.ts
    - packages/pi-coding-agent/src/core/extensions/loader.ts
    - src/resources/extensions/gsd/bootstrap/register-hooks.ts

key-decisions:
  - "emitBeforeModelSelect bound into ExtensionRuntime at ExtensionRunner construction (not bindCore) since it's a runner capability not a mode action"
  - "First-override-wins semantics for before_model_select: first handler returning non-undefined wins, loop short-circuits"

patterns-established:
  - "emit-via-runtime: ExtensionRunner sets runtime.emitXxx = (event) => this.emitXxx(event) at construction for API delegation"

requirements-completed: []

# Metrics
duration: 12min
completed: 2026-03-26
---

# Phase 01 Plan 04: before_model_select Extension Hook Summary

**before_model_select hook wired end-to-end in extension API: event type, result type, subscription overload, emission method on ExtensionAPI, runner implementation via invokeHandlers, runtime binding, and GSD placeholder handler**

## Performance

- **Duration:** 12 min
- **Started:** 2026-03-26T22:10:00Z
- **Completed:** 2026-03-26T22:22:08Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Added BeforeModelSelectEvent interface and BeforeModelSelectResult type to extension types (unitType, unitId, classification, taskMetadata, eligibleModels, phaseConfig fields)
- Added on('before_model_select') overload and emitBeforeModelSelect() to ExtensionAPI interface
- Implemented emitBeforeModelSelect() on ExtensionRunner using invokeHandlers with first-override-wins semantics
- Bound emitBeforeModelSelect from runner into shared ExtensionRuntime at construction time
- Wired emitBeforeModelSelect delegation through createExtensionAPI in loader.ts
- Registered before_model_select placeholder handler in GSD's register-hooks.ts with ADR-004 reference

## Task Commits

Each task was committed atomically:

1. **Task 1: Add BeforeModelSelectEvent to ExtensionAPI types and wire emission** - `113a2168` feat
2. **Task 2: Register before_model_select handler in GSD hooks** - `164a2e7d` feat

## Files Created/Modified

- `packages/pi-coding-agent/src/core/extensions/types.ts` - Added BeforeModelSelectEvent, BeforeModelSelectResult interfaces; on('before_model_select') overload; emitBeforeModelSelect method on ExtensionAPI; emitBeforeModelSelect field on ExtensionRuntimeState
- `packages/pi-coding-agent/src/core/extensions/runner.ts` - Added emitBeforeModelSelect() method to ExtensionRunner; binds into runtime at construction
- `packages/pi-coding-agent/src/core/extensions/loader.ts` - Added emitBeforeModelSelect stub to createExtensionRuntime(); wired async delegation in createExtensionAPI()
- `src/resources/extensions/gsd/bootstrap/register-hooks.ts` - Added before_model_select handler placeholder returning undefined with ADR-004 comment

## Decisions Made

- **emitBeforeModelSelect bound at construction, not bindCore:** The method is a runner capability (calling into its own extensions), not a mode-provided action. Binding at ExtensionRunner constructor time ensures it's always available without waiting for the interactive mode to call bindCore().
- **First-override-wins semantics:** The before_model_select handler loop uses `done: true` on the first non-undefined handler result, short-circuiting. This ensures the first extension to claim routing wins, matching the ADR-004 design for predictable extension ordering.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added emitBeforeModelSelect to ExtensionRuntimeState and bound at construction**
- **Found during:** Task 1 (wiring emitBeforeModelSelect into createExtensionAPI)
- **Issue:** The plan said to check if `runtime.runner` or `runtime` itself has the emit methods. Neither did — the ExtensionRuntime interface had no emit methods and no runner reference. The createExtensionAPI function can only delegate through the runtime object.
- **Fix:** Added emitBeforeModelSelect to ExtensionRuntimeState interface; initialized with no-op stub in createExtensionRuntime(); bound the runner's implementation at ExtensionRunner construction time; delegation in createExtensionAPI() goes through runtime.emitBeforeModelSelect().
- **Files modified:** types.ts, runner.ts, loader.ts
- **Verification:** TypeScript compiles cleanly with no errors in extension files.
- **Committed in:** 113a2168 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 2 - missing critical wiring mechanism)
**Impact on plan:** The fix was required for correctness — without it, the emitBeforeModelSelect delegation had no path through createExtensionAPI. No scope creep; the pattern follows existing conventions.

## Issues Encountered

None — once the runtime delegation pattern was established (mirroring how registerProvider works), the implementation was straightforward.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- before_model_select hook is fully defined and wired through the extension API
- Plan 05 can call pi.emitBeforeModelSelect() from selectAndApplyModel() to fire the hook before capability scoring
- GSD's placeholder handler is registered and ready to be replaced with real routing logic
- TypeScript is clean — all new interfaces and methods type-check correctly

## Self-Check: PASSED

- FOUND: packages/pi-coding-agent/src/core/extensions/types.ts (contains BeforeModelSelectEvent, before_model_select, BeforeModelSelectResult, emitBeforeModelSelect)
- FOUND: packages/pi-coding-agent/src/core/extensions/runner.ts (contains emitBeforeModelSelect, invokeHandlers)
- FOUND: packages/pi-coding-agent/src/core/extensions/loader.ts (contains emitBeforeModelSelect)
- FOUND: src/resources/extensions/gsd/bootstrap/register-hooks.ts (contains before_model_select, ADR-004)
- FOUND: .planning/phases/01-capability-aware-model-routing/01-04-SUMMARY.md
- FOUND commit 113a2168 (feat: Task 1)
- FOUND commit 164a2e7d (feat: Task 2)

---
*Phase: 01-capability-aware-model-routing*
*Completed: 2026-03-26*
