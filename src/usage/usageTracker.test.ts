import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractUsage } from "../llm/recordingClient.js";
import { getRunCost, getUsage, readRecords, recordExecution, recordRunSummary } from "./usageTracker.js";

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
      { userId: "user-1", runId: "run-99", latencyMs: 4_200, terminationReason: "natural_completion" },
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
      { userId: "user-1", runId: "run-99", latencyMs: 3_000, terminationReason: "max_iterations" },
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
