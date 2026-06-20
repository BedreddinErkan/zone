import { log } from "../utils/logger.js";
import { getRequestContext } from "./openaiContext.js";
import { getModelForRole } from "./modelRouting.js";
import type { ToolResult } from "../tools/toolExecutor.js";
import type {
  IterCostAccumulator,
  IterCostUpdatePayload,
} from "../usage/iterCostMeter.js";
import type { SubagentResult } from "./subagents.js";
import { WORKER_ALLOWED_TOOLS } from "./subagents.js";
import type { CapabilityFilter, Capability } from "../tools/capabilities.js";

/**
 * Resolves a Task tool subagent_type to the CapabilityFilter for that subagent's
 * runAgentLoop call. Centralizes worker/explore mapping away from toolExecutor.ts.
 * Gap 6.B: worker will move to {allow: ["fs.read","fs.write"]} once find_references
 * expansion is validated — for now verbatim match of WORKER_ALLOWED_TOOLS.
 */
export function resolveSubagentCapabilityFilter(
  subagentType: "worker" | "explore" | "verifier"
): CapabilityFilter {
  switch (subagentType) {
    case "explore":
      return { allow: new Set<Capability>(["fs.read"]) };
    case "worker":
      return { allowToolNames: new Set(WORKER_ALLOWED_TOOLS) };
    case "verifier":
      return { allow: new Set<Capability>(["fs.read", "shell.exec"]) };
  }
}

export function extractDispatchReason(description: unknown): string {
  if (typeof description !== "string") return "manual";
  const firstLine = description.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = firstLine.match(/^(multi_file_fanout|exploration|long_isolated_step)\s*:/i);
  if (m) return m[1].toLowerCase();
  return "manual";
}

function cleanTokenNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Logs [zone-subagent-dispatched] for every Task tool execution.
 * outcome is the resolved SubagentSummary.status from the result JSON;
 * defaults to "success" when called by legacy callers without the argument.
 */
export function logSubagentDispatched(
  parsedArgs: Record<string, unknown>,
  runId: string | null | undefined,
  iterNumber: number,
  outcome?: string
): void {
  const dispatchReason = extractDispatchReason(parsedArgs.description);
  const dispatchSubagentType =
    typeof parsedArgs.subagent_type === "string" ? parsedArgs.subagent_type : null;
  const dispatchProvider = getRequestContext()?.provider ?? "openai";
  const dispatchWorkerModel =
    dispatchSubagentType === "worker"
      ? getModelForRole("worker", dispatchProvider)
      : null;
  log("[zone-subagent-dispatched]", JSON.stringify({
    event: "subagent_dispatched",
    parentRunId: runId ?? null,
    subagentType: dispatchSubagentType,
    workerModel: dispatchWorkerModel,
    dispatchReason,
    iter: iterNumber + 1,
    outcome: outcome ?? "success",
  }));
}

export interface SubagentResultInput {
  result: ToolResult;
  iterNumber: number;
  runId: string | null | undefined;
  onStructuredEvent: ((evt: unknown) => void) | undefined;
  /** Mutated in place: subagent's filesModified are merged into this set. */
  filesModified: Set<string>;
  /** Current accumulated subagent tokens before this call — used for accurate cumulative log. */
  subagentTokenTotal: number;
  /** Current accumulated subagent cost before this call — used for accurate cumulative log. */
  subagentCostTotal: number;
  mainAgentTokens: () => number;
  effectiveTokenBudgetCap: number;
  iterCostAccumulator: IterCostAccumulator;
  lastIterCostPayload: IterCostUpdatePayload | null;
}

export interface SubagentResultOutput {
  /** Amount to add to outer subagentTokenTotal. Update the outer variable BEFORE calling emitTokenBudgetStatus. */
  subagentTokenDelta: number;
  /** Amount to add to outer subagentCostTotal. */
  subagentCostDelta: number;
}

/**
 * Parses a successful Task tool result: aggregates filesModified, propagates
 * token and cost accumulators, and emits the corresponding zone log markers.
 *
 * Does NOT handle the token-budget check or early return — the caller must
 * update subagentTokenTotal with the returned delta BEFORE calling
 * emitTokenBudgetStatus so the closure reads the correct cumulative value.
 */
export function handleSubagentResult(opts: SubagentResultInput): SubagentResultOutput {
  let subagentTokenDelta = 0;
  let subagentCostDelta = 0;

  try {
    const parsed = JSON.parse(opts.result.output) as Partial<SubagentResult>;

    if (Array.isArray(parsed.filesModified)) {
      for (const filePath of parsed.filesModified) {
        if (typeof filePath === "string" && filePath.trim()) {
          opts.filesModified.add(filePath.trim());
        }
      }
    }

    const tokenUsage = parsed.tokenUsage;
    const subagentTotal = cleanTokenNumber(tokenUsage?.total);
    if (subagentTotal > 0) {
      subagentTokenDelta = subagentTotal;
      const mainTokensAfter = opts.mainAgentTokens();
      const cumulativeAfter = mainTokensAfter + opts.subagentTokenTotal + subagentTotal;
      log("[zone-subagent-token-propagated]", JSON.stringify({
        mainRunId: opts.runId ?? null,
        subagentId: parsed.subagentId,
        subagentTotal,
        subagentInput: cleanTokenNumber(tokenUsage?.input),
        subagentOutput: cleanTokenNumber(tokenUsage?.output),
        mainCumulativeAfter: cumulativeAfter,
        cap: opts.effectiveTokenBudgetCap,
        ratio: opts.effectiveTokenBudgetCap > 0 ? cumulativeAfter / opts.effectiveTokenBudgetCap : 0,
      }));
    }

    const subagentCostUsd =
      typeof parsed.costUsd === "number" && parsed.costUsd > 0 ? parsed.costUsd : 0;
    if (subagentCostUsd > 0) {
      subagentCostDelta = subagentCostUsd;
      const cumulativeCostAfter =
        opts.iterCostAccumulator.total_cost + opts.subagentCostTotal + subagentCostUsd;
      log("[zone-subagent-cost-propagated]", JSON.stringify({
        mainRunId: opts.runId ?? null,
        subagentId: parsed.subagentId,
        subagentCostUsd,
        mainCumulativeCostAfter: cumulativeCostAfter,
      }));
      if (opts.lastIterCostPayload && typeof opts.runId === "string" && opts.runId.trim()) {
        opts.onStructuredEvent?.({
          ...opts.lastIterCostPayload,
          iterCost: 0,
          cumulativeCost: cumulativeCostAfter,
        });
      }
    }
  } catch {
    // Best-effort only. Task summaries are user-visible tool content,
    // but modified-file aggregation should not make the loop fail.
  }

  return { subagentTokenDelta, subagentCostDelta };
}
