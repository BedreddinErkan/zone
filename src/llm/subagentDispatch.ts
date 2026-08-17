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

/**
 * The dispatch-reason vocabulary — the single source of truth for every site
 * that names these prefixes.
 *
 * Three sites used to carry their own copy: this parser, the TASK SUBAGENTS
 * system-prompt block, and `buildPlanAnnotationsBlock`'s closing directive.
 * They disagreed, and the failure mode is silent rather than loud: a fourth
 * prefix, `focused_diagnosis`, was added to the prompt block at `f2b852c4` —
 * along with a test asserting the prompt named it — and never to this parser,
 * whose matcher has had one version since `c4145085`. Every dispatch using it
 * therefore recorded the fallback instead. Nothing failed; the field just lied,
 * until `7c4a1a7d` removed the prefix again while also dropping `exploration`
 * from the same block for size, which is what left prompt and parser at two
 * versus three.
 *
 * Both prompt sites now render this array through `renderDispatchReasonPrefixes`,
 * so prompt and parser cannot drift without editing one literal.
 * `dispatchReasonAgreement.test.ts` fails if they do.
 */
export const DISPATCH_REASON_PREFIXES = [
  "multi_file_fanout",
  "exploration",
  "long_isolated_step",
] as const;

/** What `extractDispatchReason` reports when no prefix matches. Not a prefix —
 *  never add it to DISPATCH_REASON_PREFIXES, or the prompt would instruct the
 *  model to type it. */
export const DISPATCH_REASON_FALLBACK = "manual";

export type DispatchReason =
  | (typeof DISPATCH_REASON_PREFIXES)[number]
  | typeof DISPATCH_REASON_FALLBACK;

/** Same character class as this repo's four other local copies (toolExecutor.ts,
 *  runLlmPatchFlow.ts, rankRelevantFiles.ts, computeRiskScoreDetails.ts). */
function escapeRegExpChars(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the matcher from a vocabulary rather than hand-writing it, which is
 * what makes "parser ≡ constant" true by construction instead of by review.
 *
 * Members are escaped even though the vocabulary is `[a-z_]` by convention:
 * escaping makes the guard structural, so a member carrying a regex
 * metacharacter is matched literally rather than silently changing what the
 * matcher does. The convention is pinned by a test as well — the pair is
 * deliberate, since a test only protects an edit that runs it.
 *
 * Exported for that test, which feeds it a metacharacter-bearing vocabulary the
 * real constant will never contain.
 */
export function buildDispatchReasonMatcher(prefixes: readonly string[]): RegExp {
  return new RegExp(`^(${prefixes.map(escapeRegExpChars).join("|")})\\s*:`, "i");
}

const DISPATCH_REASON_RE = buildDispatchReasonMatcher(DISPATCH_REASON_PREFIXES);

/** Renders the vocabulary for a prompt string. Both prompt sites call this, so
 *  neither can name a prefix this module cannot read. */
export function renderDispatchReasonPrefixes(separator = " / "): string {
  return DISPATCH_REASON_PREFIXES.join(separator);
}

export function extractDispatchReason(description: unknown): DispatchReason {
  if (typeof description !== "string") return DISPATCH_REASON_FALLBACK;
  const firstLine = description.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = firstLine.match(DISPATCH_REASON_RE);
  if (m) return m[1].toLowerCase() as DispatchReason;
  return DISPATCH_REASON_FALLBACK;
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
  /** Token delta from this subagent call. The caller passes it straight into
   *  TokenBudgetMeter.recordSubagentResult, which applies it before reading
   *  the cumulative total. */
  subagentTokenDelta: number;
  /** Amount to add to outer subagentCostTotal. */
  subagentCostDelta: number;
}

/**
 * Parses a successful Task tool result: aggregates filesModified, propagates
 * token and cost accumulators, and emits the corresponding zone log markers.
 *
 * Does NOT handle the token-budget check or early return — the caller
 * (handleToolResult.ts) passes the returned delta into
 * TokenBudgetMeter.recordSubagentResult, which applies it and reads the
 * cumulative total from within the same method call.
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
