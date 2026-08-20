import { vi, describe, it, expect, afterEach } from "vitest";
import { TokenBudgetMeter } from "./TokenBudgetMeter.js";

function makeRawUsage(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0
): Record<string, unknown> {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    prompt_tokens_details: null,
  };
}

describe("TokenBudgetMeter", () => {
  describe("constructor + initial state", () => {
    it("cumulativeTokens equals baseTokens, mainAgentTokens and tokenUsage.total are 0", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 1000,
        cap: 800_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      expect(meter.cumulativeTokens).toBe(1000);
      expect(meter.mainAgentTokens).toBe(0);
      expect(meter.tokenUsage.total).toBe(0);
      expect(meter.subagentTokenTotal).toBe(0);
      expect(meter.subagentCostTotal).toBe(0);
      expect(meter.lastIterCostPayload).toBeNull();
    });
  });

  describe("recordLLMCall", () => {
    it("accumulates tokenUsage.total as input + output", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 800_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(500, 100),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      expect(meter.tokenUsage.total).toBe(600);
    });

    it("accumulates mainAgentTokens from iterCostAccumulator", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 800_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(500, 100),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      expect(meter.mainAgentTokens).toBe(600); // input_uncached:500 + output:100
    });

    it("emits iter_cost_update payload via onStructuredEvent", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 800_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.recordLLMCall({
        rawUsage: makeRawUsage(100, 50),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        onStructuredEvent: spy,
      });
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0]).toMatchObject({ type: "iter_cost_update", iter: 1 });
    });

    it("does not emit SSE when runId is empty", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 800_000,
        isSubagentLoop: false,
        runId: "",
      });
      const spy = vi.fn();
      meter.recordLLMCall({
        rawUsage: makeRawUsage(100, 50),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        onStructuredEvent: spy,
      });
      expect(spy).not.toHaveBeenCalled();
    });

    it("accumulates over multiple calls", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 800_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(200, 50),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(300, 100),
        iter: 2,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      expect(meter.tokenUsage.total).toBe(650);
      expect(meter.tokenUsage.perIter).toEqual([250, 400]);
      expect(meter.iterCostAccumulator.iter_count).toBe(2);
    });

    it("exposes lastIterTokenTotal for the last iter", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 800_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(300, 100),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      expect(meter.lastIterTokenTotal).toBe(400);
    });
  });

  describe("recordSubagentResult ordering invariant", () => {
    it("emits token_budget_status with tokens already included in cumulativeTokens", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.recordSubagentResult({ tokens: 500, cost: 0.01 }, 2, spy);
      expect(spy).toHaveBeenCalledOnce();
      const event = spy.mock.calls[0][0] as { cumulativeTokens: number };
      expect(event.cumulativeTokens).toBe(500);
    });

    it("returns ratio including the new subagent tokens", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const { ratio } = meter.recordSubagentResult({ tokens: 95_000, cost: 0.01 }, 1, () => {});
      expect(ratio).toBeCloseTo(0.95, 3);
    });

    it("cost is updated AFTER emitStatus — ordering preserved", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      let costAtEmit = -1;
      meter.recordSubagentResult({ tokens: 100, cost: 5.0 }, 1, () => {
        costAtEmit = meter.subagentCostTotal;
      });
      expect(costAtEmit).toBe(0);
      expect(meter.subagentCostTotal).toBe(5.0);
    });

    it("subagentTokenTotal reflects updated value after call", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordSubagentResult({ tokens: 300, cost: 0 }, 1, () => {});
      meter.recordSubagentResult({ tokens: 200, cost: 0 }, 2, () => {});
      expect(meter.subagentTokenTotal).toBe(500);
    });
  });

  describe("recordSubagentCostOnly", () => {
    it("updates subagentCostTotal without emitting", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.recordSubagentCostOnly(7.5);
      expect(meter.subagentCostTotal).toBe(7.5);
      expect(meter.subagentTokenTotal).toBe(0);
      // no SSE emitted
      meter.emitStatus(1, spy);
      // spy is called by emitStatus, but not by recordSubagentCostOnly
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  describe("emitStatus payload shape", () => {
    it("emits all 8 required fields", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 1000,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      const ratio = meter.emitStatus(3, spy);
      expect(spy).toHaveBeenCalledOnce();
      const event = spy.mock.calls[0][0] as Record<string, unknown>;
      expect(event.type).toBe("token_budget_status");
      expect(event.title).toBe("Token budget");
      expect(event.cumulativeTokens).toBe(1000);
      expect(event.tokenBudgetCap).toBe(10_000);
      expect(event.tokenBudgetRatio).toBe(ratio);
      expect(event.iter).toBe(3);
      expect(event.breakdown).toMatchObject({
        mainAgent: expect.any(Number),
        subagents: expect.any(Number),
      });
      expect(event.status).toBe("active");
    });

    it("status:error when ratio >= 0.95", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 9500,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      expect((spy.mock.calls[0][0] as { status: string }).status).toBe("error");
    });

    it("status:warning when ratio >= 0.8 and < 0.95", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 8000,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      expect((spy.mock.calls[0][0] as { status: string }).status).toBe("warning");
    });

    it("status:active when ratio < 0.8", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 500,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      expect((spy.mock.calls[0][0] as { status: string }).status).toBe("active");
    });

    it("breakdown flip: isSubagentLoop=true puts baseTokens in mainAgent", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 1000,
        cap: 10_000,
        isSubagentLoop: true,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      const { breakdown } = spy.mock.calls[0][0] as {
        breakdown: { mainAgent: number; subagents: number };
      };
      expect(breakdown.mainAgent).toBe(1000);
      expect(breakdown.subagents).toBe(0);
    });

    it("breakdown normal: isSubagentLoop=false puts baseTokens+mainTokens in mainAgent", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 1000,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      const { breakdown } = spy.mock.calls[0][0] as {
        breakdown: { mainAgent: number; subagents: number };
      };
      expect(breakdown.mainAgent).toBe(1000); // base + 0 mainAgentTokens
      expect(breakdown.subagents).toBe(0);
    });

    it("does not emit when runId is empty", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 1000,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      expect(spy).not.toHaveBeenCalled();
    });

    it("returns ratio even when no SSE emitted (empty runId)", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 5000,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "",
      });
      const ratio = meter.emitStatus(1, () => {});
      expect(ratio).toBeCloseTo(0.5, 3);
    });
  });

  describe("snapshot()", () => {
    it("costUsd = iterCostAccumulator.total_cost + subagentCostTotal", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordSubagentCostOnly(3.0);
      const snap = meter.snapshot();
      expect(snap.costUsd).toBe(3.0);
    });

    it("cumulativeTokens matches getter", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 500,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordSubagentResult({ tokens: 200, cost: 0 }, 1, () => {});
      const snap = meter.snapshot();
      expect(snap.cumulativeTokens).toBe(meter.cumulativeTokens);
      expect(snap.cumulativeTokens).toBe(700);
    });

    it("tokenUsage snapshot matches tokenUsage getter (defensive copy)", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(100, 50),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      const snap = meter.snapshot();
      expect(snap.tokenUsage).toEqual(meter.tokenUsage);
    });
  });

  describe("read-only getters pass-through", () => {
    it("lastIterCostPayload is null before any call, non-null after", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      expect(meter.lastIterCostPayload).toBeNull();
      meter.recordLLMCall({
        rawUsage: makeRawUsage(100, 50),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      expect(meter.lastIterCostPayload).not.toBeNull();
      expect(meter.lastIterCostPayload?.type).toBe("iter_cost_update");
    });

    it("iterCostAccumulator.iter_count tracks call count", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(100, 50),
        iter: 1,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(200, 80),
        iter: 2,
        totalIter: 15,
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
      });
      expect(meter.iterCostAccumulator.iter_count).toBe(2);
    });
  });

  describe("cache-aware budget ratio", () => {
    // input_tokens in Anthropic's API = truly uncached (not total).
    // makeRawUsage(input, output, cacheRead, cacheWrite) — input = truly uncached.
    // effectiveBudget = input_uncached + cache_write + round(cache_read * 0.1) + output.

    it("heavy-cache: ratio uses discounted budget, raw cumulativeTokens unchanged", () => {
      const cap = 800_000;
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap, isSubagentLoop: false, runId: "r" });
      const spy = vi.fn();
      meter.recordLLMCall({
        rawUsage: makeRawUsage(10_000, 5_000, 90_000, 0),
        iter: 1, totalIter: 15, provider: "anthropic",
        model: "claude-sonnet-4-6", onStructuredEvent: spy,
      });
      // effective = 10K + 0 + round(90K*0.1) + 5K = 10K+9K+5K = 24K
      const ratio = meter.emitStatus(1);
      expect(ratio).toBeCloseTo(24_000 / cap, 4);
      // raw total = truly_uncached + cache_read + output = 10K+90K+5K = 105K
      expect(meter.cumulativeTokens).toBe(105_000);
    });

    it("no-cache: effective budget equals raw total (regression — unchanged for pure new work)", () => {
      const cap = 800_000;
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap, isSubagentLoop: false, runId: "r" });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(100_000, 5_000, 0, 0),
        iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      // effective = 100K + 0 + 0 + 5K = 105K = raw total
      const ratio = meter.emitStatus(1);
      expect(ratio).toBeCloseTo(105_000 / cap, 4);
      expect(meter.cumulativeTokens).toBe(105_000);
    });

    it("cap fires on effective tokens, not raw — 94%-cache run with raw > cap survives", () => {
      const cap = 60_000;
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap, isSubagentLoop: false, runId: "r" });
      // raw = 300 + 70_000 + 600 = 70_900 > cap
      // effective = 300 + 0 + round(70_000*0.1) + 600 = 300+7_000+600 = 7_900 << cap*0.95
      meter.recordLLMCall({
        rawUsage: makeRawUsage(300, 600, 70_000, 0),
        iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      const ratio = meter.emitStatus(1);
      expect(meter.cumulativeTokens).toBeGreaterThan(cap); // raw exceeds cap
      expect(ratio).toBeLessThan(0.95);                    // effective does NOT trigger budget exit
    });

    it("cache_write counted once at full weight (not discounted)", () => {
      const cap = 800_000;
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap, isSubagentLoop: false, runId: "r" });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(10_000, 5_000, 90_000, 30_000),
        iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      // effective = 10K + 30K + round(90K*0.1) + 5K = 10K+30K+9K+5K = 54K
      const ratio = meter.emitStatus(1);
      expect(ratio).toBeCloseTo(54_000 / cap, 4);
    });

    it("effectiveCumulativeTokens includes baseTokens + discounted cache_read", () => {
      const meter = new TokenBudgetMeter({ baseTokens: 5_000, cap: 800_000, isSubagentLoop: false, runId: "r1" });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(300, 600, 70_000, 0),
        iter: 0, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      // effective = 5_000 (base) + 300 (input_uncached) + round(70_000×0.1) + 600 (output)
      //           = 5_000 + 300 + 7_000 + 600 = 12_900
      expect(meter.effectiveCumulativeTokens).toBe(12_900);
      // raw cumulativeTokens includes full cache_read
      expect(meter.cumulativeTokens).toBe(5_000 + 300 + 70_000 + 600); // 75_900
    });
  });

  describe("ZONE_CACHE_READ_BUDGET_DISCOUNT env knob", () => {
    afterEach(() => {
      delete process.env["ZONE_CACHE_READ_BUDGET_DISCOUNT"];
    });

    it("absent env → default 0.1 (byte-identical to hardcoded behavior)", () => {
      delete process.env["ZONE_CACHE_READ_BUDGET_DISCOUNT"];
      const cap = 800_000;
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap, isSubagentLoop: false, runId: "r" });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(10_000, 5_000, 90_000, 0),
        iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      // effective = 10K + 0 + round(90K*0.1) + 5K = 24K (same as hardcoded 0.1)
      expect(meter.emitStatus(1)).toBeCloseTo(24_000 / cap, 4);
    });

    it("ZONE_CACHE_READ_BUDGET_DISCOUNT=0.25 raises effective budget consumption for cache_read", () => {
      process.env["ZONE_CACHE_READ_BUDGET_DISCOUNT"] = "0.25";
      const cap = 800_000;
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap, isSubagentLoop: false, runId: "r" });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(10_000, 5_000, 90_000, 0),
        iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      // effective = 10K + 0 + round(90K*0.25) + 5K = 10K+22.5K+5K = 37.5K
      expect(meter.emitStatus(1)).toBeCloseTo(37_500 / cap, 4);
      // higher than the 0.1 default (24K/800K)
      expect(meter.emitStatus(1)).toBeGreaterThan(24_000 / cap);
    });

    it("invalid/NaN ZONE_CACHE_READ_BUDGET_DISCOUNT falls back to 0.1", () => {
      process.env["ZONE_CACHE_READ_BUDGET_DISCOUNT"] = "not-a-number";
      const cap = 800_000;
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap, isSubagentLoop: false, runId: "r" });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(10_000, 5_000, 90_000, 0),
        iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      // NaN → fallback 0.1 → effective = 24K (same as default)
      expect(meter.emitStatus(1)).toBeCloseTo(24_000 / cap, 4);
    });
  });

  /**
   * Items 254/255: the loop had five createChatCompletion sites feeding recordLLMCall at
   * only two of them, so costUsd silently missed whole calls on runs that hit a terminal
   * exit or compacted. The fix adds three more call sites (agentLoop.ts) plus a fourth via
   * new compaction plumbing (ContextCompactor.ts/summarizer.ts) — all four go through this
   * same recordLLMCall, so its own behaviour under the two conditions the fix depends on is
   * pinned here rather than left to fall out of the call-site plumbing.
   */
  describe("recordLLMCall — missing/malformed usage is a safe no-op (item 255)", () => {
    it("rawUsage: undefined leaves costUsd and tokenUsage unchanged, and does not throw", () => {
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap: 800_000, isSubagentLoop: false, runId: "r1" });
      expect(() =>
        meter.recordLLMCall({
          rawUsage: undefined,
          iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
        })
      ).not.toThrow();
      expect(meter.snapshot().costUsd).toBe(0);
      expect(meter.tokenUsage.total).toBe(0);
      expect(meter.iterCostAccumulator.iter_count).toBe(0);
    });

    it("a malformed usage object (all-zero/missing fields) is the same safe no-op", () => {
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap: 800_000, isSubagentLoop: false, runId: "r1" });
      expect(() =>
        meter.recordLLMCall({
          rawUsage: { not_a_real_field: 123 },
          iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
        })
      ).not.toThrow();
      expect(meter.snapshot().costUsd).toBe(0);
    });

    it("a real call recorded AFTER a malformed one is unaffected — the no-op does not corrupt the accumulator", () => {
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap: 800_000, isSubagentLoop: false, runId: "r1" });
      meter.recordLLMCall({
        rawUsage: undefined,
        iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(1_000_000, 0), // $3.00 at claude-sonnet-4-6's $3/MTok input rate
        iter: 2, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      expect(meter.snapshot().costUsd).toBeCloseTo(3.0, 6);
      expect(meter.iterCostAccumulator.iter_count).toBe(1); // the no-op never incremented it
    });
  });

  describe("recordLLMCall — additive independence across sites (item 255's per-site attribution claim)", () => {
    it("two calls' costs sum exactly — real rates, not fixture-model zero-cost", () => {
      // claude-sonnet-4-6: input $3/MTok, output $15/MTok (src/usage/pricing.ts).
      const meter = new TokenBudgetMeter({ baseTokens: 0, cap: 800_000, isSubagentLoop: false, runId: "r1" });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(1_000_000, 0), // $3.00
        iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      meter.recordLLMCall({
        rawUsage: makeRawUsage(0, 1_000_000), // $15.00
        iter: 2, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6",
      });
      expect(meter.snapshot().costUsd).toBeCloseTo(18.0, 6);
    });

    it("simulates 'silencing one site': the total is exactly the sum minus the removed call's own contribution, not the whole run's cost", () => {
      // The property the acceptance test's per-site mutation kill depends on: because the
      // accumulator is additive, omitting one recordLLMCall removes exactly that call's
      // delta and leaves every other site's contribution untouched — proven directly here
      // rather than inferred from reading buildIterCostUpdate's accumulator shape.
      const withBoth = new TokenBudgetMeter({ baseTokens: 0, cap: 800_000, isSubagentLoop: false, runId: "r1" });
      withBoth.recordLLMCall({ rawUsage: makeRawUsage(1_000_000, 0), iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6" });
      withBoth.recordLLMCall({ rawUsage: makeRawUsage(0, 1_000_000), iter: 2, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6" });

      const siteTwoSilenced = new TokenBudgetMeter({ baseTokens: 0, cap: 800_000, isSubagentLoop: false, runId: "r1" });
      siteTwoSilenced.recordLLMCall({ rawUsage: makeRawUsage(1_000_000, 0), iter: 1, totalIter: 15, provider: "anthropic", model: "claude-sonnet-4-6" });
      // site two's recordLLMCall omitted — simulating an unfed call site

      expect(withBoth.snapshot().costUsd).toBeCloseTo(18.0, 6);
      expect(siteTwoSilenced.snapshot().costUsd).toBeCloseTo(3.0, 6); // exactly site one's own cost, not 0 and not 18
      expect(withBoth.snapshot().costUsd - siteTwoSilenced.snapshot().costUsd).toBeCloseTo(15.0, 6); // exactly the missing call's own cost
    });
  });
});
