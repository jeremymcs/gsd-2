# Swarm Delivery Plan — Workflow Engine, State Machine, Single Writer, UOK, GitHub Routines

## Why this plan exists

This document defines a practical "swarm" execution model so multiple contributors can move in parallel without creating orchestration conflicts. The scope is the five areas requested:

1. Workflow engine
2. State machine
3. Single-writer coordination
4. Unified Orchestration Kernel (UOK)
5. GitHub routines

## Swarm topology (team layout)

Use a hub-and-spoke model with one integration owner and four specialist lanes.

| Lane | Primary ownership | Key outputs |
|---|---|---|
| Lane A: Workflow Engine | dispatch contract, execution graph plumbing | scheduler contract updates, dispatch observability |
| Lane B: State Machine | phase transitions, guards, recovery behavior | transition table, fail-closed checks, replay tests |
| Lane C: Single Writer | deterministic state writes and conflict avoidance | append/commit policy, lock discipline, audit continuity |
| Lane D: UOK Control Planes | gate/model/gitops/audit consistency | flags policy, parity proofs, migration safety checks |
| Lane E: GitHub Routines | branch/PR/check/release automation | required checks, PR templates, rollout routines |
| Hub: Integrator (Single Writer of record) | merge arbitration and final state publication | daily integration branch, release candidate cut |

## Delivery guardrails

- **Single-writer rule:** only the hub merges into the integration branch; lanes submit PRs against that branch.
- **Contract-first rule:** each lane must modify typed contracts and tests before implementation details.
- **Fail-closed gating:** when uncertain state is detected, transition to blocked/reassess path rather than implicit success.
- **Traceability:** every dispatch and state write must emit auditable metadata (unit id, phase, actor, timestamp, source commit).

## Work breakdown by area

## 1) Workflow engine lane

### Objectives
- Keep all execution kinds (`unit`, `hook`, `subagent`, `team-worker`, `verification`, `reprocess`) on one scheduler contract.
- Ensure dispatch decisions are deterministic from disk state + control-plane flags.

### Backlog
- Normalize dispatcher inputs into one typed envelope (phase, nextAction, constraints, gate verdict).
- Add execution graph snapshots before and after each unit.
- Enforce explicit dispatch reason codes (`policy`, `state`, `recovery`, `manual`).

### Done criteria
- Scheduler path chosen from a single contract function.
- Unit tests cover each execution kind and at least one recovery path.
- Query surface can explain "why this unit ran now".

## 2) State machine lane

### Objectives
- Make transitions explicit, bounded, and replayable.
- Prevent hidden transitions from side effects.

### Backlog
- Publish authoritative transition matrix (`from`, `event`, `guard`, `to`, `onFail`).
- Add idempotency tests for repeated `query`, `next`, and interrupted `auto` turns.
- Add crash-recovery tests proving state resumes from disk truth.

### Done criteria
- Transition matrix checked in as source-of-truth artifact.
- No implicit transition paths remain in hot code.
- Replay suite demonstrates deterministic outcomes for seeded scenarios.

## 3) Single-writer lane

### Objectives
- Eliminate split-brain state updates.
- Guarantee ordering for state + gitops + audit records.

### Backlog
- Define writer ownership protocol: one active writer token per turn.
- Gate all state persistence through a single write adapter.
- Emit monotonic sequence numbers per turn for state/audit/gitops correlation.

### Done criteria
- Concurrent write attempts are rejected or queued deterministically.
- Audit log can reconstruct exact write order from sequence ids.
- Recovery path preserves sequence continuity after restart.

## 4) UOK lane

### Objectives
- Keep UOK as default runtime path with safe emergency fallback.
- Prove parity between legacy and UOK on critical scenarios.

### Backlog
- Confirm default-on flags and scoped fallback controls.
- Add parity replay pack across planning, dispatch, gitops, and audit events.
- Harden gate/model/gitops plane boundaries with typed interfaces.

### Done criteria
- UOK path is default in stable builds.
- Legacy path accessible only via emergency controls.
- Parity report generated for release candidate branches.

## 5) GitHub routines lane

### Objectives
- Make PR flow and releases support swarm speed without reducing safety.

### Backlog
- Introduce lane labels (`lane/workflow`, `lane/state`, `lane/writer`, `lane/uok`, `lane/github`).
- Require PR template sections: impact area, transition risks, rollback plan, test evidence.
- Add mandatory checks for lane-specific suites + full integration suite on hub merges.
- Add release checklist issue template for cutover validation.

### Done criteria
- Branch protection enforces required checks and review ownership.
- Lane PRs auto-route reviewers by CODEOWNERS paths.
- Integration PR has machine-generated summary of merged lane deltas.

## Operating cadence

- **Daily async standup (per lane):** blockers, changed contracts, risk flags.
- **Daily integration window (hub):** rebase lanes, run integration suite, publish status.
- **Twice-weekly architecture sync:** transition changes, gate policy deltas, fallback posture.
- **Release drill (weekly):** simulate rollback and recovery from a failed integration candidate.

## Risk register

| Risk | Detection | Mitigation |
|---|---|---|
| Hidden state transition | transition coverage gaps | require matrix delta in PR + replay test |
| Dual-writer race | out-of-order sequence ids | single writer token + queued writes |
| UOK/legacy drift | parity replay mismatch | block release until parity pack passes |
| GitHub routine bottleneck | growing PR cycle time | parallel lane checks + smaller PR slicing |

## Suggested 3-phase rollout

1. **Phase 1: Contract freeze (2-3 days)**
   - lock transition matrix format, scheduler envelope, writer protocol.
2. **Phase 2: Lane implementation (1-2 weeks)**
   - lanes deliver independently behind feature flags where needed.
3. **Phase 3: Integration hardening (3-5 days)**
   - parity replay, rollback drill, release candidate signoff.

## Minimal command routine for hub integrator

```bash
# 1) Sync and test lane branch
git fetch origin

git checkout lane/<name>
pnpm test --filter "uok|state|workflow"

# 2) Merge to integration branch (hub only)
git checkout integration/uok-swarm
git merge --no-ff lane/<name>
pnpm test

# 3) Publish integration status
git push origin integration/uok-swarm
```

## Success metrics

- Median PR lead time per lane < 24h.
- Zero unrecoverable state corruption incidents.
- 100% of dispatches explainable via reason codes.
- 100% of release candidates include parity replay report.
- Rollback drill completes within agreed SLO.
