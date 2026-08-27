import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractUsage } from "../llm/recordingClient.js";
import {
  getRunCost,
  getRunCostUnknownCount,
  getUsage,
  readRecords,
  recordExecution,
  recordRunRetry,
  recordRunSummary,
} from "./usageTracker.js";

let storageDir: string;

beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-usage-"));
});

afterEach(() => {
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe("usageTracker subagent telemetry compatibility", () => {
  it("reads legacy JSONL records without subagent fields and aggregates as before", async () => {
    const legacy = {
      timestamp: new Date().toISOString(),
      userId: "user-1",
      runId: "run-1",
      provider: "openai",
      model: "gpt-4o-mini",
      input_uncached: 100,
      cache_write: 0,
      cache_read: 0,
      output: 20,
      est_cost_usd: 0.0001,
    };
    fs.writeFileSync(path.join(storageDir, "user-1.jsonl"), `${JSON.stringify(legacy)}\n`, "utf8");

    const records = readRecords("user-1", { storageDir });
    expect(records).toHaveLength(1);
    expect(records[0]?.subagentId).toBeUndefined();

    const usage = await getUsage("user-1", "all", { storageDir });
    expect(usage.totalRuns).toBe(1);
    expect(usage.totalTokens).toBe(120);
    expect(getRunCost("user-1", "run-1", { storageDir })).toBe(0.0001);
  });

  it("persists subagent telemetry fields and includes records in parent run cost", async () => {
    const rec = await recordExecution(
      {
        userId: "user-1",
        runId: "run-1",
        subagentId: "abc",
        subagentType: "worker",
        parentRunId: "run-1",
        provider: "openai",
        model: "gpt-4o-mini",
        input_uncached: 100,
        cache_write: 0,
        cache_read: 0,
        output: 20,
      },
      { storageDir }
    );

    const records = readRecords("user-1", { storageDir });
    expect(records[0]).toMatchObject({
      subagentId: "abc",
      subagentType: "worker",
      parentRunId: "run-1",
    });
    expect(getRunCost("user-1", "run-1", { storageDir })).toBe(rec.est_cost_usd);
  });

  it("K.3.C3: recordRunSummary round-trips latencyMs + terminationReason through JSONL", async () => {
    await recordRunSummary(
      { userId: "user-1", runId: "run-99", provider: "anthropic", latencyMs: 4_200, terminationReason: "natural_completion" },
      { storageDir }
    );

    const records = readRecords("user-1", { storageDir });
    expect(records).toHaveLength(1);
    expect(records[0]?.latencyMs).toBe(4_200);
    expect(records[0]?.terminationReason).toBe("natural_completion");
    // Zero-cost sentinel must not pollute aggregates
    expect(records[0]?.est_cost_usd).toBe(0);
    expect(records[0]?.input_uncached).toBe(0);
  });

  it("K.3.C3: recordRunSummary does not inflate run count or token totals", async () => {
    // A real LLM call record
    await recordExecution(
      { userId: "user-1", runId: "run-99", provider: "openai", model: "gpt-5.4-mini",
        input_uncached: 200, cache_write: 0, cache_read: 50, output: 30 },
      { storageDir }
    );
    // Terminal summary record for the same run
    await recordRunSummary(
      { userId: "user-1", runId: "run-99", provider: "openai", latencyMs: 3_000, terminationReason: "max_iterations" },
      { storageDir }
    );

    const usage = await getUsage("user-1", "all", { storageDir });
    // Two JSONL records but same runId → 1 run counted
    expect(usage.totalRuns).toBe(1);
    // Only real record's tokens count: 200+0+50+30 = 280
    expect(usage.totalTokens).toBe(280);
    // Summary record's est_cost_usd = 0 — total must not go negative
    expect(usage.totalCostUsd).toBeGreaterThanOrEqual(0);
  });

  it("maps OpenAI prompt_tokens_details.cached_tokens to cache_read", async () => {
    const usage = extractUsage({
      prompt_tokens: 1000,
      completion_tokens: 25,
      total_tokens: 1025,
      prompt_tokens_details: {
        cached_tokens: 700,
        audio_tokens: 0,
      },
    });

    expect(usage).toEqual({
      input_uncached: 300,
      cache_write: 0,
      cache_read: 700,
      output: 25,
      output_reasoning: 0,
      webSearchRequests: 0,
    });

    await recordExecution(
      {
        userId: "user-1",
        runId: "run-2",
        provider: "openai",
        model: "gpt-5.4",
        ...usage!,
      },
      { storageDir }
    );

    expect(readRecords("user-1", { storageDir })[0]?.cache_read).toBe(700);
  });
});

describe("web search cost capture", () => {
  it("extractUsage reads web_search_requests from flat usage field", () => {
    const usage = extractUsage({ input_tokens: 100, output_tokens: 10, web_search_requests: 3 });
    expect(usage?.webSearchRequests).toBe(3);
  });

  it("extractUsage defaults webSearchRequests to 0 when field absent", () => {
    const usage = extractUsage({ input_tokens: 100, output_tokens: 10 });
    expect(usage?.webSearchRequests).toBe(0);
  });

  it("recordExecution includes web search flat fee in est_cost_usd", async () => {
    const rec = await recordExecution(
      {
        userId: "u",
        runId: "r",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input_uncached: 0,
        cache_write: 0,
        cache_read: 0,
        output: 0,
        webSearchRequests: 2,
      },
      { storageDir }
    );
    expect(rec.est_cost_usd).toBeCloseTo(0.02, 6); // 2 × $0.01
  });

  it("recordExecution with zero web searches has no flat fee", async () => {
    const rec = await recordExecution(
      {
        userId: "u2",
        runId: "r2",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input_uncached: 0,
        cache_write: 0,
        cache_read: 0,
        output: 0,
        webSearchRequests: 0,
      },
      { storageDir }
    );
    expect(rec.est_cost_usd).toBe(0);
  });
});

describe("item 221 — sentinel records carry the run's real provider, not a hardcoded literal", () => {
  it("recordRunSummary round-trips an anthropic provider", async () => {
    await recordRunSummary(
      { userId: "user-1", runId: "run-a", provider: "anthropic", latencyMs: 100, terminationReason: "natural_completion" },
      { storageDir }
    );
    const records = readRecords("user-1", { storageDir });
    expect(records[0]?.provider).toBe("anthropic");
  });

  it("recordRunSummary round-trips an openai provider — the other direction of the same pin", async () => {
    await recordRunSummary(
      { userId: "user-1", runId: "run-b", provider: "openai", latencyMs: 100, terminationReason: "natural_completion" },
      { storageDir }
    );
    const records = readRecords("user-1", { storageDir });
    expect(records[0]?.provider).toBe("openai");
  });

  it("recordRunRetry round-trips the passed provider", async () => {
    await recordRunRetry(
      { userId: "user-1", runId: "run-c", provider: "anthropic" },
      { storageDir }
    );
    const records = readRecords("user-1", { storageDir });
    expect(records[0]?.provider).toBe("anthropic");
  });

  it("getUsage().byProvider no longer phantom-counts an anthropic-only run under openai", async () => {
    // A real Anthropic-only run: one inference record, plus the terminal sentinel.
    await recordExecution(
      { userId: "user-1", runId: "run-d", provider: "anthropic", model: "claude-sonnet-4-6",
        input_uncached: 100, cache_write: 0, cache_read: 0, output: 10 },
      { storageDir }
    );
    await recordRunSummary(
      { userId: "user-1", runId: "run-d", provider: "anthropic", latencyMs: 500, terminationReason: "natural_completion" },
      { storageDir }
    );

    const usage = await getUsage("user-1", "all", { storageDir });
    expect(usage.byProvider.anthropic?.runs).toBe(1);
    // The pre-fix defect: every sentinel's runId landed in the openai bucket regardless
    // of the run's real provider. This is the assertion that catches its return.
    expect(usage.byProvider.openai?.runs ?? 0).toBe(0);
  });
});

describe("unknown cost is not zero — the ledger semantics of est_cost_usd: null (item 387)", () => {
  /**
   * The distinction this pins cannot be reached through `recordExecution` with either built-in
   * profile, because both carry a pricing table. It is reached the way the ledger will actually
   * meet it: a row already on disk carrying `est_cost_usd: null`. Without this test the nullable
   * field is an annotation with no behavioural contract — every reader used to coerce it with
   * `|| 0`, which is exactly the "unpriceable run looks free" conflation the field exists to end.
   */
  function writeRows(rows: Array<Record<string, unknown>>): void {
    fs.writeFileSync(
      path.join(storageDir, "user-1.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8"
    );
  }

  const base = {
    timestamp: new Date().toISOString(),
    userId: "user-1",
    runId: "run-1",
    provider: "openai",
    model: "gpt-4o-mini",
    input_uncached: 100,
    cache_write: 0,
    cache_read: 0,
    output: 20,
  };

  it("getUsage excludes an unknown-cost record from the money total and counts it instead", async () => {
    writeRows([
      { ...base, est_cost_usd: 0.25 },
      { ...base, runId: "run-2", est_cost_usd: null, unpriceable: true },
    ]);
    const usage = await getUsage("user-1", "all", { storageDir });
    // The known row's cost, and ONLY it. Summing the unknown as 0 would give the same number,
    // so the count below is what makes the two cases distinguishable.
    expect(usage.totalCostUsd).toBeCloseTo(0.25, 10);
    expect(usage.unknownCostRecords).toBe(1);
  });

  it("a genuinely-free record and an unknown-cost record are NOT the same thing", async () => {
    writeRows([{ ...base, est_cost_usd: 0 }]);
    const free = await getUsage("user-1", "all", { storageDir });
    writeRows([{ ...base, est_cost_usd: null, unpriceable: true }]);
    const unknown = await getUsage("user-1", "all", { storageDir });

    // Both report $0.00 — which is precisely why the total alone cannot tell them apart, and why
    // the count exists.
    expect(free.totalCostUsd).toBe(0);
    expect(unknown.totalCostUsd).toBe(0);
    expect(free.unknownCostRecords).toBe(0);
    expect(unknown.unknownCostRecords).toBe(1);
  });

  it("getUsage reports zero unknowns when every record is priced", async () => {
    writeRows([{ ...base, est_cost_usd: 0.25 }, { ...base, est_cost_usd: 0.5 }]);
    const usage = await getUsage("user-1", "all", { storageDir });
    expect(usage.totalCostUsd).toBeCloseTo(0.75, 10);
    expect(usage.unknownCostRecords).toBe(0);
  });

  it("getRunCost sums only the priced records, and the sibling reports what it left out", () => {
    writeRows([
      { ...base, est_cost_usd: 0.25 },
      { ...base, est_cost_usd: null, unpriceable: true },
      { ...base, est_cost_usd: 0.1 },
    ]);
    expect(getRunCost("user-1", "run-1", { storageDir })).toBeCloseTo(0.35, 10);
    expect(getRunCostUnknownCount("user-1", "run-1", { storageDir })).toBe(1);
  });

  it("getRunCostUnknownCount is zero for a fully-priced run and for an unknown runId", () => {
    writeRows([{ ...base, est_cost_usd: 0.25 }]);
    expect(getRunCostUnknownCount("user-1", "run-1", { storageDir })).toBe(0);
    expect(getRunCostUnknownCount("user-1", "no-such-run", { storageDir })).toBe(0);
    expect(getRunCostUnknownCount("user-1", "", { storageDir })).toBe(0);
  });

  it("recordExecution writes null — not 0 — when the caller marks the record unpriceable", async () => {
    const rec = await recordExecution(
      {
        userId: "user-1",
        runId: "run-1",
        provider: "openai",
        model: "some-gateway-model",
        input_uncached: 100,
        cache_write: 0,
        cache_read: 0,
        output: 20,
        unpriceable: true,
      },
      { storageDir }
    );
    expect(rec.est_cost_usd).toBeNull();
    // And it survives the JSONL round-trip as null rather than being read back as 0.
    const [readBack] = readRecords("user-1", { storageDir });
    expect(readBack?.est_cost_usd).toBeNull();
  });

  it("an ordinary record still records a real number — the null path is opt-in, not the default", async () => {
    // A million input tokens, deliberately: `round4` quantises to four decimals, so a 100-token
    // gpt-4o-mini call costs $0.000027 and rounds to a literal 0 — a third kind of zero that is
    // neither "free" nor "unknown". Using a cost that survives rounding keeps this test about the
    // opt-in null path rather than about rounding.
    const rec = await recordExecution(
      {
        userId: "user-1",
        runId: "run-1",
        provider: "openai",
        model: "gpt-4o-mini",
        input_uncached: 1_000_000,
        cache_write: 0,
        cache_read: 0,
        output: 200_000,
      },
      { storageDir }
    );
    expect(typeof rec.est_cost_usd).toBe("number");
    expect(rec.est_cost_usd).toBeGreaterThan(0);
  });
});
