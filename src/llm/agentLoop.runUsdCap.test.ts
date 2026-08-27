/**
 * `--max-budget-usd` / `AgentLoopInput.runUsdCap` — ledger item 259's last member.
 *
 * WHAT THIS PINS, and why each case is here rather than resting on a source read:
 *
 *  1. The cap BINDS once this run's spend reaches it, and a cap above actual spend stops nothing —
 *     the second half is what makes it a ceiling rather than a tripwire that fires on any run.
 *  2. It stops BEFORE the next LLM call, so no iteration is left half-done. Asserted by counting
 *     LLM calls, not by reading the placement.
 *  3. **A cap smaller than one iteration's cost still runs one iteration.** At iter 0 spend is $0,
 *     so a `>=` gate cannot fire before any work happens. That is a deliberate decision, not a
 *     rounding artefact: per-iteration cost is not knowable in advance, so refusing at startup
 *     would require a number nobody has. The summary must say one iteration ran, because a message
 *     that reads as though nothing happened would be false.
 *  4. Subagent loops do not gate — the parent's meter already contains their spend, so gating both
 *     would double-enforce one budget. The deliberate opposite of `--max-turns`'s parent-only
 *     scope: turns are per-loop, dollars are per-run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";

const toolExecutorMock = vi.hoisted(() => ({
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  clearCommandCacheForRun: vi.fn(),
  clearCommandCacheForTest: vi.fn(),
  clearOutlineCacheForTest: vi.fn(),
  isMemoizableCommand: vi.fn(),
  computeCommandFingerprint: vi.fn(),
  truncateCommandOutput: vi.fn(),
  resolveAgentPath: vi.fn(),
  resolveRunCommandCwd: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ createChatCompletion: vi.fn() }));
const loggerMock = vi.hoisted(() => ({ debugLog: vi.fn(), errorLog: vi.fn(), log: vi.fn() }));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);
vi.mock("../utils/logger.js", () => loggerMock);

import { runAgentLoop } from "./agentLoop.js";

/** 40k prompt tokens at gpt-4o pricing ($2.50/1M) ≈ $0.10 per iteration. */
const COSTLY = { prompt_tokens: 40_000, completion_tokens: 100, total_tokens: 40_100 };

function llmReadFile(i: number) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: `rf-${i}`, type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ filePath: "src/a.ts", _n: i }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: COSTLY,
  };
}

function capMarkers() {
  return loggerMock.log.mock.calls.filter((a: unknown[]) =>
    String(a[0]).includes("[zone-run-usd-cap]"));
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-runusdcap-"));
  resetToolExecutorMock(toolExecutorMock);
  toolExecutorMock.executeTool.mockImplementation(async (name: string) => {
    if (name === "read_file") return { success: true, output: "// content" };
    return { success: false, output: "unsupported" };
  });
  toolExecutorMock.withStagingTempFlush.mockResolvedValue(undefined);
  mocks.createChatCompletion.mockReset();
  loggerMock.debugLog.mockReset();
  loggerMock.errorLog.mockReset();
  loggerMock.log.mockReset();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("runUsdCap binds as a per-run ceiling (item 259)", () => {
  it("stops the run once spend reaches the cap, before the next LLM call", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () => llmReadFile(i++));

    const result = await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath,
      mode: "patch",
      runId: "cap-run-1", // required for cost to accumulate in TokenBudgetMeter
      runUsdCap: 0.25,
    });

    expect(result.terminationReason).toBe("run_usd_cap_exceeded");
    expect(result.success).toBe(false);
    // ~$0.10/iter against a $0.25 cap: iterations 0,1,2 run; the gate fires entering iter 3.
    expect(result.iterCount).toBe(3);
    // Stopped BEFORE the next call, so calls never exceed the iterations actually run.
    expect(mocks.createChatCompletion.mock.calls.length).toBe(3);
    expect(capMarkers()).toHaveLength(1);
    const payload = JSON.parse(String(capMarkers()[0]![1]));
    expect(payload.capUsd).toBe(0.25);
    expect(payload.spentUsd).toBeGreaterThanOrEqual(0.25);
  });

  it("a cap above actual spend stops nothing — a ceiling, not a tripwire", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () =>
      i++ < 1 ? llmReadFile(i) : {
        choices: [{ message: { content: "Done. [ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null }, finish_reason: "stop" }],
        usage: COSTLY,
      });

    const result = await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath,
      mode: "patch",
      runId: "cap-run-2",
      runUsdCap: 1000,
    });

    expect(result.terminationReason).not.toBe("run_usd_cap_exceeded");
    expect(capMarkers()).toHaveLength(0);
  });

  it("a cap below one iteration's cost still runs exactly one iteration, and says so", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () => llmReadFile(i++));

    const result = await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath,
      mode: "patch",
      runId: "cap-run-3",
      runUsdCap: 0.0001, // far below ~$0.10 for a single iteration
    });

    expect(result.terminationReason).toBe("run_usd_cap_exceeded");
    expect(result.iterCount).toBe(1);
    expect(mocks.createChatCompletion.mock.calls.length).toBe(1);
    // The message must not read as though nothing ran.
    expect(result.summary).toContain("1 iteration");
    expect(result.summary).not.toContain("0 iterations");
  });

  it("no cap set — the gate never fires", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () =>
      i++ < 1 ? llmReadFile(i) : {
        choices: [{ message: { content: "Done. [ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null }, finish_reason: "stop" }],
        usage: COSTLY,
      });

    await runAgentLoop({
      task: "implement the feature in the codebase",
      repoPath, mode: "patch", runId: "cap-run-4",
    });

    expect(capMarkers()).toHaveLength(0);
  });
});

describe("subagent loops do not gate on the parent's runUsdCap (item 259)", () => {
  it("the gate is skipped for a subagent loop, because the parent's meter already counts its spend", async () => {
    let i = 0;
    mocks.createChatCompletion.mockImplementation(async () => llmReadFile(i++));

    const result = await runAgentLoop({
      task: "explore the codebase",
      repoPath,
      mode: "patch",
      runId: "cap-sub-1",
      runUsdCap: 0.0001,
      maxIterationsOverride: 2,
      subagent: { parentRunId: "parent-1", subagentId: "sub-1", type: "explore" },
    } as Parameters<typeof runAgentLoop>[0]);

    expect(result.terminationReason).not.toBe("run_usd_cap_exceeded");
    expect(capMarkers()).toHaveLength(0);
  });
});

/**
 * Reachability of the inert-budget-gate warning, driven through a real run.
 *
 * `--max-budget-usd` on a run whose profile cannot price is an inert ceiling: the accumulated cost
 * never leaves zero, so the per-iteration comparison above can never fire and the run proceeds to
 * its iteration limit under a flag whose only purpose is bounding it. Step 3 wired this warning and
 * it could not fire, because every reachable profile priced. Driven here through `runAgentLoop`
 * with an injected profile rather than by calling the helper directly (item 392).
 */
describe("--max-budget-usd on an unpriceable profile warns that the gate is inert (item 392)", () => {
  const UNPRICEABLE = {
    id: "test-gateway",
    protocol: "openai-chat" as const,
    adapterProvider: "openai" as const,
    keyRef: { envVar: "TEST_GATEWAY_KEY", keyExample: "sk-…" },
  };

  /** A terminal response: the warning fires before the loop opens, so one clean iteration is enough. */
  function llmDone() {
    return {
      choices: [{ message: { content: "done", tool_calls: null }, finish_reason: "stop" }],
      usage: COSTLY,
    };
  }

  it("warns once, naming the cap and the profile", async () => {
    mocks.createChatCompletion.mockResolvedValue(llmDone());
    const { _resetProviderProfileWarningsForTest } = await import("./providerProfile.js");
    _resetProviderProfileWarningsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-inert-gate",
      runUsdCap: 2.5,
      profile: UNPRICEABLE,
    });

    const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("[zone-budget-gate-inert]"));
    expect(line).toBeDefined();
    expect(line).toContain("$2.50");
    expect(line).toContain("test-gateway");
    warn.mockRestore();
  });

  it("says nothing when the same run uses a profile that can price", async () => {
    mocks.createChatCompletion.mockResolvedValue(llmDone());
    const { _resetProviderProfileWarningsForTest, OPENAI_PROFILE } = await import("./providerProfile.js");
    _resetProviderProfileWarningsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-priceable-gate",
      runUsdCap: 2.5,
      profile: OPENAI_PROFILE,
    });

    expect(warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("[zone-budget-gate-inert]")))
      .toBeUndefined();
    warn.mockRestore();
  });

  it("says nothing without a cap, even on an unpriceable profile — the warning is about the gate", async () => {
    mocks.createChatCompletion.mockResolvedValue(llmDone());
    const { _resetProviderProfileWarningsForTest } = await import("./providerProfile.js");
    _resetProviderProfileWarningsForTest();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      task: "do something",
      repoPath,
      userId: "user-1",
      runId: "test-run-no-cap",
      profile: UNPRICEABLE,
    });

    expect(warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("[zone-budget-gate-inert]")))
      .toBeUndefined();
    warn.mockRestore();
  });
});
