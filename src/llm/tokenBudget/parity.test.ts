/**
 * Parity lock-in tests: verify TokenBudgetMeter produces identical payload
 * shapes and threshold behavior to the old agentLoop.ts closures.
 */
import { vi, describe, it, expect } from "vitest";
import { TokenBudgetMeter } from "./TokenBudgetMeter.js";

describe("TokenBudgetMeter parity", () => {
  describe("emitStatus payload shape — preserved verbatim", () => {
    it("emits all 8 required fields with correct types", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 1000,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "run-parity-1",
      });
      const spy = vi.fn();
      const ratio = meter.emitStatus(5, spy);

      expect(spy).toHaveBeenCalledOnce();
      const event = spy.mock.calls[0][0] as Record<string, unknown>;

      // All 8 fields must be present with exact keys
      expect(Object.keys(event).sort()).toEqual(
        ["breakdown", "cumulativeTokens", "iter", "status", "title",
         "tokenBudgetCap", "tokenBudgetRatio", "type"].sort()
      );
      expect(event.type).toBe("token_budget_status");
      expect(event.title).toBe("Token budget");
      expect(typeof event.cumulativeTokens).toBe("number");
      expect(typeof event.tokenBudgetCap).toBe("number");
      expect(typeof event.tokenBudgetRatio).toBe("number");
      expect(event.tokenBudgetRatio).toBe(ratio);
      expect(event.iter).toBe(5);
      expect(event.breakdown).toMatchObject({
        mainAgent: expect.any(Number),
        subagents: expect.any(Number),
      });
      expect(typeof event.status).toBe("string");
    });

    it("tokenBudgetRatio matches return value", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 4000,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "run-parity-2",
      });
      const spy = vi.fn();
      const ratio = meter.emitStatus(1, spy);
      const event = spy.mock.calls[0][0] as { tokenBudgetRatio: number };
      expect(event.tokenBudgetRatio).toBe(ratio);
      expect(ratio).toBeCloseTo(0.4, 5);
    });
  });

  describe("threshold status values — TOKEN_BUDGET_HARD=0.95, TOKEN_BUDGET_WARN=0.8", () => {
    it("status:error exactly at TOKEN_BUDGET_HARD (0.95)", () => {
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

    it("status:error above TOKEN_BUDGET_HARD", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 9999,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      expect((spy.mock.calls[0][0] as { status: string }).status).toBe("error");
    });

    it("status:warning exactly at TOKEN_BUDGET_WARN (0.8)", () => {
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

    it("status:warning between TOKEN_BUDGET_WARN and TOKEN_BUDGET_HARD", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 9000,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      expect((spy.mock.calls[0][0] as { status: string }).status).toBe("warning");
    });

    it("status:active just below TOKEN_BUDGET_WARN", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 7999,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      expect((spy.mock.calls[0][0] as { status: string }).status).toBe("active");
    });

    it("status:active at zero tokens", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 10_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      expect((spy.mock.calls[0][0] as { status: string }).status).toBe("active");
    });
  });

  describe("breakdown field — isSubagentLoop flip preserved verbatim", () => {
    it("non-subagent: breakdown.mainAgent = base + mainTokens", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 1000,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      const { breakdown } = spy.mock.calls[0][0] as {
        breakdown: { mainAgent: number; subagents: number };
      };
      expect(breakdown.mainAgent).toBe(1000); // base + 0 main = 1000
      expect(breakdown.subagents).toBe(0);
    });

    it("subagent loop: breakdown.mainAgent = base only; subagents = mainTokens", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 5000,
        cap: 100_000,
        isSubagentLoop: true,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.emitStatus(1, spy);
      const { breakdown } = spy.mock.calls[0][0] as {
        breakdown: { mainAgent: number; subagents: number };
      };
      // isSubagentLoop=true: mainAgent=baseTokens, subagents=mainTokens+subagentTotal
      expect(breakdown.mainAgent).toBe(5000);
      expect(breakdown.subagents).toBe(0);
    });
  });

  describe("recordSubagentResult atomicity — ordering invariant lock-in", () => {
    it("onStructuredEvent fires with token already included in cumulativeTokens", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 1000,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const captured: number[] = [];
      meter.recordSubagentResult({ tokens: 5000, cost: 0 }, 3, (e) => {
        captured.push((e as { cumulativeTokens: number }).cumulativeTokens);
      });
      // Must be 1000 (base) + 5000 (subagent, already added), not 1000
      expect(captured[0]).toBe(6000);
    });

    it("onStructuredEvent fires exactly once per call", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const spy = vi.fn();
      meter.recordSubagentResult({ tokens: 100, cost: 0 }, 1, spy);
      expect(spy).toHaveBeenCalledOnce();
    });

    it("ratio returned matches cumulativeTokens / cap", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "r1",
      });
      const { ratio } = meter.recordSubagentResult(
        { tokens: 80_000, cost: 0 },
        1,
        () => {}
      );
      expect(ratio).toBeCloseTo(0.8, 5);
    });

    it("no SSE event when runId is empty (even via recordSubagentResult)", () => {
      const meter = new TokenBudgetMeter({
        baseTokens: 0,
        cap: 100_000,
        isSubagentLoop: false,
        runId: "",
      });
      const spy = vi.fn();
      meter.recordSubagentResult({ tokens: 100, cost: 0 }, 1, spy);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
