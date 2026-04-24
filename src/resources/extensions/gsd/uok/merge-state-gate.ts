/**
 * UOK merge-state-check gate.
 *
 * Wraps `reconcileMergeState` so the existing leftover-merge / squash detection
 * runs through the UOK gate runner — gaining gate_runs persistence and unified
 * audit events while preserving the current auto-loop semantics.
 *
 * Scope matches `reconcileMergeState`: MERGE_HEAD + SQUASH_MSG. The auto-mode
 * workflow only produces commit/merge state; rebase/cherry-pick/revert/bisect
 * remain doctor's concern.
 */

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { reconcileMergeState, type MergeReconcileResult } from "../auto-recovery.js";
import { nativeConflictFiles } from "../native-git-bridge.js";
import type { GateExecutionInput } from "./gate-runner.js";

export const MERGE_STATE_GATE_ID = "merge-state-check";
export const MERGE_STATE_RECONCILED_RATIONALE = "merge state reconciled";

export function buildMergeStateGate(ctx: ExtensionContext): GateExecutionInput {
  return {
    id: MERGE_STATE_GATE_ID,
    type: "input",
    execute: async (runCtx) => {
      const result = reconcileMergeState(runCtx.basePath, ctx);
      if (result === "clean") {
        return { outcome: "pass", failureClass: "none" };
      }
      if (result === "reconciled") {
        return {
          outcome: "pass",
          failureClass: "none",
          rationale: MERGE_STATE_RECONCILED_RATIONALE,
        };
      }
      let conflicts: string[] = [];
      try {
        conflicts = nativeConflictFiles(runCtx.basePath);
      } catch {
        // Best-effort — failing to enumerate conflicts shouldn't crash the gate.
      }
      return {
        outcome: "manual-attention",
        failureClass: "git",
        rationale: "merge state blocked",
        findings: conflicts.length > 0 ? conflicts.join(", ") : "code conflicts present",
      };
    },
  };
}

export function translateGateResultToMergeReconcile(result: {
  outcome: string;
  rationale?: string;
}): MergeReconcileResult {
  if (result.outcome === "pass") {
    return result.rationale === MERGE_STATE_RECONCILED_RATIONALE ? "reconciled" : "clean";
  }
  return "blocked";
}
