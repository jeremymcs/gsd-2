/**
 * custom-workflow-engine.ts — WorkflowEngine implementation for custom workflows.
 *
 * Drives the auto-loop using GRAPH.yaml step state from a run directory.
 * Each iteration: deriveState reads the graph, resolveDispatch picks the
 * next eligible step, reconcile marks it complete and persists.
 *
 * Observability:
 * - All state reads/writes go through graph.ts YAML I/O — inspectable on disk.
 * - `resolveDispatch` returns unitType "custom-step" with unitId "<name>/<stepId>".
 * - `getDisplayMetadata` provides step N/M progress for dashboard rendering.
 * - Phase transitions are derivable from GRAPH.yaml step statuses.
 */

import type { WorkflowEngine } from "./workflow-engine.ts";
import type {
  EngineState,
  EngineDispatchAction,
  CompletedStep,
  ReconcileResult,
  DisplayMetadata,
} from "./engine-types.ts";
import {
  readGraph,
  writeGraph,
  getNextPendingStep,
  markStepComplete,
  type WorkflowGraph,
} from "./graph.ts";

export class CustomWorkflowEngine implements WorkflowEngine {
  readonly engineId = "custom";
  private readonly runDir: string;

  constructor(runDir: string) {
    this.runDir = runDir;
  }

  /**
   * Derive engine state from GRAPH.yaml on disk.
   *
   * Phase is "complete" when all steps are complete or expanded,
   * "running" otherwise (any pending or active steps remain).
   */
  async deriveState(_basePath: string): Promise<EngineState> {
    const graph = readGraph(this.runDir);
    const allDone = graph.steps.every(
      (s) => s.status === "complete" || s.status === "expanded",
    );
    const phase = allDone ? "complete" : "running";

    return {
      phase,
      currentMilestoneId: null,
      activeSliceId: null,
      activeTaskId: null,
      isComplete: allDone,
      raw: graph,
    };
  }

  /**
   * Resolve the next dispatch action from graph state.
   *
   * Uses getNextPendingStep to find the first step whose dependencies
   * are all satisfied. Returns a dispatch with unitType "custom-step"
   * and unitId in "<workflowName>/<stepId>" format.
   */
  async resolveDispatch(
    state: EngineState,
    _context: { basePath: string },
  ): Promise<EngineDispatchAction> {
    const graph = state.raw as WorkflowGraph;
    const next = getNextPendingStep(graph);

    if (!next) {
      return {
        action: "stop",
        reason: "All steps complete",
        level: "info",
      };
    }

    return {
      action: "dispatch",
      step: {
        unitType: "custom-step",
        unitId: `${graph.metadata.name}/${next.id}`,
        prompt: next.prompt,
      },
    };
  }

  /**
   * Reconcile state after a step completes.
   *
   * Extracts the stepId from the completedStep's unitId (last segment after `/`),
   * marks it complete in the graph, and writes the updated GRAPH.yaml to disk.
   *
   * Returns "milestone-complete" when all steps are now done, "continue" otherwise.
   */
  async reconcile(
    state: EngineState,
    completedStep: CompletedStep,
  ): Promise<ReconcileResult> {
    const graph = state.raw as WorkflowGraph;

    // Extract stepId from "<workflowName>/<stepId>"
    const parts = completedStep.unitId.split("/");
    const stepId = parts[parts.length - 1];

    const updatedGraph = markStepComplete(graph, stepId);
    writeGraph(this.runDir, updatedGraph);

    const allDone = updatedGraph.steps.every(
      (s) => s.status === "complete" || s.status === "expanded",
    );

    return {
      outcome: allDone ? "milestone-complete" : "continue",
    };
  }

  /**
   * Return UI-facing metadata for progress display.
   *
   * Shows "Step N/M" progress where N = completed count and M = total.
   */
  getDisplayMetadata(state: EngineState): DisplayMetadata {
    const graph = state.raw as WorkflowGraph;
    const total = graph.steps.length;
    const completed = graph.steps.filter((s) => s.status === "complete").length;

    return {
      engineLabel: "WORKFLOW",
      currentPhase: state.phase,
      progressSummary: `Step ${completed}/${total}`,
      stepCount: { completed, total },
    };
  }
}
