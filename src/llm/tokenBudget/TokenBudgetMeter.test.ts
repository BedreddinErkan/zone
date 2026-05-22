import { vi, describe, it, expect } from "vitest";
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
});
