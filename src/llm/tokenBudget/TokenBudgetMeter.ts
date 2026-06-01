import { debugLog } from "../../utils/logger.js";
import {
  type IterCostAccumulator,
  type IterCostUpdatePayload,
  emptyIterCostAccumulator,
  buildIterCostUpdate,
} from "../../usage/iterCostMeter.js";
import { type SubagentTokenUsage, emptySubagentTokenUsage } from "../subagents.js";
import { extractUsage } from "../recordingClient.js";
import type { ProviderName } from "../../usage/pricing.js";

// Mirrors agentLoop.ts module-level constants — do not change independently.
const TOKEN_BUDGET_HARD = 0.95;
const TOKEN_BUDGET_WARN = 0.8;
// Anthropic cache reads cost ~10× less than fresh input. The budget ratio uses this
// discount so a cache-heavy run burns capacity proportionally to actual spend, not raw tokens.
const CACHE_READ_BUDGET_DISCOUNT = 0.1;

function extractTokenUsageForBudget(
  rawUsage: unknown
): Omit<SubagentTokenUsage, "perIter"> {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { input: 0, output: 0, cached: 0, total: 0 };
  }
  const usage = rawUsage as Record<string, unknown>;
  const promptTokenDetails =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : null;
  const n = (v: unknown): number => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  const input = n(usage.prompt_tokens ?? usage.input_tokens);
  const output = n(usage.completion_tokens ?? usage.output_tokens);
  const cached = n(promptTokenDetails?.cached_tokens ?? usage.cache_read_input_tokens);
  return { input, output, cached, total: input + output };
}

export class TokenBudgetMeter {
  private readonly _baseTokens: number;
  private readonly _cap: number;
  private readonly _isSubagentLoop: boolean;
  private readonly _runId: string;

  private _iterCostAccumulator: IterCostAccumulator = emptyIterCostAccumulator();
  private _lastIterCostPayload: IterCostUpdatePayload | null = null;
  private _lastCallModel: string | null = null;
  private _loopTokenUsage: SubagentTokenUsage = emptySubagentTokenUsage();
  private _subagentTokenTotal = 0;
  private _subagentCostTotal = 0;
  private _lastIterTokenTotal = 0;

  constructor(opts: {
    baseTokens: number;
    cap: number;
    isSubagentLoop: boolean;
    runId: string;
  }) {
    this._baseTokens = opts.baseTokens;
    this._cap = opts.cap;
    this._isSubagentLoop = opts.isSubagentLoop;
    this._runId = opts.runId;
  }

  recordLLMCall(opts: {
    rawUsage: unknown;
    iter: number;
    totalIter: number;
    provider: string;
    model: string;
    onStructuredEvent?: (e: unknown) => void;
  }): void {
    const { rawUsage, iter, totalIter, provider, model, onStructuredEvent } = opts;

    const iterUsage = extractTokenUsageForBudget(rawUsage);
    this._lastIterTokenTotal = iterUsage.total;
    if (iterUsage.total > 0) {
      this._loopTokenUsage = {
        input: this._loopTokenUsage.input + iterUsage.input,
        output: this._loopTokenUsage.output + iterUsage.output,
        cached: this._loopTokenUsage.cached + iterUsage.cached,
        total: this._loopTokenUsage.total + iterUsage.total,
        perIter: [...(this._loopTokenUsage.perIter ?? []), iterUsage.total],
      };
    }

    const usage = extractUsage(rawUsage);
    if (usage && this._runId) {
      try {
        const update = buildIterCostUpdate({
          runId: this._runId,
          iter,
          totalIter,
          provider: provider as ProviderName,
          model,
          current: usage,
          previous: this._iterCostAccumulator,
        });
        this._iterCostAccumulator = update.accumulator;
        this._lastIterCostPayload = update.payload;
        this._lastCallModel = model;
        onStructuredEvent?.(update.payload);
      } catch {
        debugLog("[zone-iter-cost-update-failed]", "buildIterCostUpdate threw");
      }
    }
  }

  // Enforces the ordering invariant structurally: token total updated BEFORE
  // emitStatus reads it. Replaces the manual subagentTokenTotal += delta +
  // emitTokenBudgetStatus sequence that required a load-bearing comment.
  recordSubagentResult(
    deltas: { tokens: number; cost: number },
    iterNumber: number,
    onStructuredEvent?: (e: unknown) => void
  ): { ratio: number } {
    this._subagentTokenTotal += deltas.tokens;
    const ratio = this.emitStatus(iterNumber, onStructuredEvent);
    this._subagentCostTotal += deltas.cost;
    return { ratio };
  }

  recordSubagentCostOnly(cost: number): void {
    this._subagentCostTotal += cost;
  }

  emitStatus(iterNumber: number, onStructuredEvent?: (e: unknown) => void): number {
    const mainTokens = this.mainAgentTokens;
    const totalTokens = this._baseTokens + mainTokens + this._subagentTokenTotal;
    // Effective budget discounts cache_read by 10× so cache-heavy runs consume capacity
    // proportionally to actual cost, not raw token count.
    const effectiveTokens = this._baseTokens + this.budgetAgentTokens + this._subagentTokenTotal;
    const breakdown = this._isSubagentLoop
      ? {
          mainAgent: this._baseTokens,
          subagents: mainTokens + this._subagentTokenTotal,
        }
      : {
          mainAgent: this._baseTokens + mainTokens,
          subagents: this._subagentTokenTotal,
        };
    const tokenBudgetRatio = this._cap > 0 ? effectiveTokens / this._cap : 0;
    debugLog(
      "[zone-token-budget]",
      JSON.stringify({
        iter: iterNumber,
        cumulativeTokens: totalTokens,
        effectiveBudgetTokens: effectiveTokens,
        cap: this._cap,
        ratio: Number(tokenBudgetRatio.toFixed(3)),
        breakdown,
      })
    );
    if (this._runId) {
      onStructuredEvent?.({
        type: "token_budget_status",
        title: "Token budget",
        cumulativeTokens: totalTokens,
        tokenBudgetCap: this._cap,
        tokenBudgetRatio,
        iter: iterNumber,
        breakdown,
        status:
          tokenBudgetRatio >= TOKEN_BUDGET_HARD
            ? "error"
            : tokenBudgetRatio >= TOKEN_BUDGET_WARN
              ? "warning"
              : "active",
      });
    }
    return tokenBudgetRatio;
  }

  get mainAgentTokens(): number {
    return (
      this._iterCostAccumulator.input_uncached +
      this._iterCostAccumulator.cache_read +
      this._iterCostAccumulator.cache_write +
      this._iterCostAccumulator.output
    );
  }

  // Cache-discounted token count for the budget cap check.
  // input_uncached = Anthropic's input_tokens = truly uncached (excludes cache_read/write).
  // Only cache_read is discounted 10×; uncached input and cache_write stay at full weight.
  get budgetAgentTokens(): number {
    const acc = this._iterCostAccumulator;
    return (
      acc.input_uncached +
      acc.cache_write +
      Math.round(acc.cache_read * CACHE_READ_BUDGET_DISCOUNT) +
      acc.output
    );
  }

  get cumulativeTokens(): number {
    return this._baseTokens + this.mainAgentTokens + this._subagentTokenTotal;
  }

  get effectiveCumulativeTokens(): number {
    return this._baseTokens + this.budgetAgentTokens + this._subagentTokenTotal;
  }

  get tokenUsage(): SubagentTokenUsage {
    return {
      input: this._loopTokenUsage.input,
      output: this._loopTokenUsage.output,
      cached: this._loopTokenUsage.cached,
      total: this._loopTokenUsage.total,
      perIter: [...(this._loopTokenUsage.perIter ?? [])],
    };
  }

  snapshot(): { tokenUsage: SubagentTokenUsage; costUsd: number; cumulativeTokens: number } {
    return {
      tokenUsage: this.tokenUsage,
      costUsd: this._iterCostAccumulator.total_cost + this._subagentCostTotal,
      cumulativeTokens: this.cumulativeTokens,
    };
  }

  get subagentTokenTotal(): number { return this._subagentTokenTotal; }
  get subagentCostTotal(): number { return this._subagentCostTotal; }
  get iterCostAccumulator(): IterCostAccumulator { return this._iterCostAccumulator; }
  get lastIterCostPayload(): IterCostUpdatePayload | null { return this._lastIterCostPayload; }
  get lastCallModel(): string | null { return this._lastCallModel; }
  get lastIterTokenTotal(): number { return this._lastIterTokenTotal; }
}
