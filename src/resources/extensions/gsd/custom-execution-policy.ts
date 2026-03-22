/**
 * custom-execution-policy.ts — Stub ExecutionPolicy for custom workflows.
 *
 * All methods return neutral/no-op values. This stub is wired properly
 * in S05 where verify() gains real verification logic and other methods
 * get meaningful implementations.
 *
 * Observability:
 * - verify() always returns "continue" — no verification gating.
 * - selectModel() returns null — defers to loop defaults.
 * - recover() returns retry — simple default recovery strategy.
 */

import type { ExecutionPolicy } from "./execution-policy.ts";
import type { RecoveryAction, CloseoutResult } from "./engine-types.ts";

export class CustomExecutionPolicy implements ExecutionPolicy {
  /** No workspace preparation needed for custom workflows. */
  async prepareWorkspace(_basePath: string, _milestoneId: string): Promise<void> {
    // No-op — custom workflows don't need worktree setup
  }

  /** Defer model selection to loop defaults. */
  async selectModel(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<{ tier: string; modelDowngraded: boolean } | null> {
    return null;
  }

  /** Always continue — real verification is added in S05. */
  async verify(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<"continue" | "retry" | "pause"> {
    return "continue";
  }

  /** Default recovery: retry the step. */
  async recover(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string },
  ): Promise<RecoveryAction> {
    return { outcome: "retry", reason: "Default retry" };
  }

  /** No-op closeout — no commits or artifact capture. */
  async closeout(
    _unitType: string,
    _unitId: string,
    _context: { basePath: string; startedAt: number },
  ): Promise<CloseoutResult> {
    return { committed: false, artifacts: [] };
  }
}
