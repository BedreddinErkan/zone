import type { ExecutionPlan } from "../llm/executionPlan.js";
import type {
  AgentLoopResult,
  VerificationReason,
} from "../llm/agentLoop.js";

/**
 * Tur P2.1: multi-step plan orchestrator skeleton.
 *
 * Helpers only. The actual loop lives in runLlmPatchFlow's agent_loop branch
 * (gated on `ZONE_PLAN_ORCHESTRATION=1`). Pulled into its own module so the
 * pure functions (`buildStepTask`, `aggregateOrchestratorResults`,
 * `isPlanOrchestrationEnabled`) are independently testable without standing
 * up the whole patch flow.
 *
 * State transfer between steps, cancellation propagation, and per-step verdict
 * gating are deferred to P2.2 / P2.3 / P2.4 respectively.
 */

/**
 * Reads the env flag and verifies the plan is multi-step. Single-step or
 * empty plans always go single-pass even when the flag is set — there is no
 * value in orchestrating one step.
 */
export function isPlanOrchestrationEnabled(
  plan: ExecutionPlan | null | undefined,
  envValue: string | undefined
): boolean {
  const flag = String(envValue ?? "").trim().toLowerCase();
  const flagOn = flag === "1" || flag === "true";
  if (!flagOn) return false;
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length < 2) return false;
  return true;
}

/**
 * Frames a single plan step within the user's original task so the agent
 * doesn't lose sight of the goal. Plain string concatenation — no LLM call.
 */
export function buildStepTask(
  originalTask: string,
  stepIdx: number,
  plan: ExecutionPlan
): string {
  const step = plan.steps[stepIdx];
  if (!step) return originalTask;
  const parts: string[] = [
    "ORIGINAL TASK:",
    String(originalTask ?? "").trim(),
    "",
    `CURRENT STEP (${stepIdx + 1} of ${plan.steps.length}):`,
    String(step.title ?? "").trim() || `Step ${stepIdx + 1}`,
  ];
  if (step.description && step.description.trim().length > 0) {
    parts.push("", String(step.description).trim());
  }
  if (Array.isArray(step.filesLikely) && step.filesLikely.length > 0) {
    parts.push("", `Files for this step: ${step.filesLikely.join(", ")}`);
  }
  parts.push(
    "",
    "Focus on completing ONLY this step. Other steps will be handled separately. Do not attempt the full task in this turn."
  );
  return parts.filter((line) => line !== undefined && line !== null).join("\n");
}

/**
 * Combines per-step AgentLoopResults into a single composite that matches
 * the shape downstream code in runLlmPatchFlow expects. P2.1 simplifications:
 *   - success: AND across all steps
 *   - filesModified: dedupe union
 *   - toolCallLog: concat in step order
 *   - summary: concat with step labels (last-step summary alone loses context)
 *   - error: join all step errors with `; `
 *   - patchValidatedByAgent: AND across all steps
 *   - verificationReason: last step's value (typically the verification step)
 *
 * Empty input returns a benign success result so callers can treat empty
 * runs uniformly.
 */
export function aggregateOrchestratorResults(
  results: AgentLoopResult[]
): AgentLoopResult {
  if (!Array.isArray(results) || results.length === 0) {
    return {
      success: true,
      summary: "",
      toolCallLog: [],
      filesModified: [],
      patchValidatedByAgent: false,
      verificationReason: "no_changes_made",
    };
  }

  const filesSet = new Set<string>();
  const toolLog: AgentLoopResult["toolCallLog"] = [];
  const summaries: string[] = [];
  const errors: string[] = [];
  let allSuccess = true;
  let allValidated = true;
  let lastVerificationReason: VerificationReason = "no_verification_attempted";

  for (let i = 0; i < results.length; i += 1) {
    const r = results[i]!;
    if (!r.success) allSuccess = false;
    if (!r.patchValidatedByAgent) allValidated = false;
    for (const f of r.filesModified ?? []) filesSet.add(f);
    if (Array.isArray(r.toolCallLog)) toolLog.push(...r.toolCallLog);
    if (r.summary && r.summary.trim().length > 0) {
      summaries.push(`[step ${i + 1}] ${r.summary.trim()}`);
    }
    if (r.error && r.error.trim().length > 0) {
      errors.push(`step ${i + 1}: ${r.error.trim()}`);
    }
    if (r.verificationReason) lastVerificationReason = r.verificationReason;
  }

  const composite: AgentLoopResult = {
    success: allSuccess,
    summary: summaries.join("\n\n"),
    toolCallLog: toolLog,
    filesModified: Array.from(filesSet),
    patchValidatedByAgent: allValidated,
    verificationReason: lastVerificationReason,
  };
  if (errors.length > 0) composite.error = errors.join("; ");
  return composite;
}
