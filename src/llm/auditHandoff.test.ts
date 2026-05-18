/**
 * Phase X.0.1 — audit handoff user-message injection tests.
 * Validates: AUDIT CONTEXT block renders in the user message sent to the LLM,
 * is absent when auditFindings is undefined, and interpolates cost/citations correctly.
 * Step B: validates structured sections, system prompt directive, and cache prefix invariance.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  log: vi.fn(),
  debugLog: vi.fn(),
  getUsage: vi.fn(),
  readDailyUsdCapOverride: vi.fn<() => number | undefined>(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => ({
  executeTool: mocks.executeTool,
  withStagingTempFlush: mocks.withStagingTempFlush,
}));

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: mocks.debugLog,
  errorLog: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../usage/usageTracker.js", () => ({
  getUsage: mocks.getUsage,
  recordExecution: vi.fn(),
  readRecords: vi.fn(() => []),
  recordRunSummary: vi.fn().mockResolvedValue(undefined),
  recordRunRetry: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: mocks.readDailyUsdCapOverride,
  readTierSettings: vi.fn(() => ({})),
  readAutoAuditSetting: vi.fn(() => false),
  writeTierSettings: vi.fn(),
  writeAutoAuditSetting: vi.fn(),
  writeDailyUsdCapOverride: vi.fn(),
  getTierSettingsPath: vi.fn(() => "/tmp/tier-limits.json"),
}));

import { runAgentLoop, assembleAgentSystemPrompt } from "./agentLoop.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeUsageAggregate(totalCostUsd: number) {
  return {
    period: "day" as const,
    totalRuns: 1,
    totalTokens: 1000,
    totalCostUsd,
    byProvider: {},
    byModel: {},
  };
}

function textResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function capturedUserMessage(): string {
  const firstCall = mocks.createChatCompletion.mock.calls[0];
  if (!firstCall) throw new Error("createChatCompletion was not called");
  const { messages } = firstCall[0] as { messages: Array<{ role: string; content: string }> };
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) throw new Error("No user message in first LLM call");
  return userMsg.content;
}

function capturedSystemMessage(): string {
  const firstCall = mocks.createChatCompletion.mock.calls[0];
  if (!firstCall) throw new Error("createChatCompletion was not called");
  const { messages } = firstCall[0] as { messages: Array<{ role: string; content: string }> };
  const sysMsg = messages.find((m) => m.role === "system");
  if (!sysMsg) throw new Error("No system message in first LLM call");
  return sysMsg.content;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("audit handoff — AUDIT CONTEXT user-message injection", () => {
  beforeEach(() => {
    mocks.createChatCompletion.mockClear();
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
    mocks.createChatCompletion.mockResolvedValue(textResponse("Done."));
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(0));
    mocks.readDailyUsdCapOverride.mockReturnValue(undefined);
  });

  it("includes AUDIT CONTEXT block when auditFindings is provided", async () => {
    await runAgentLoop({
      task: "add a feature",
      repoPath: "/tmp/fake",
      mode: "patch",
      auditFindings: {
        summary: "auth middleware is missing from plan.",
        citationCount: 3,
        toolCallCount: 7,
        costUsd: 0.0312,
      },
    });

    const userMsg = capturedUserMessage();
    expect(userMsg).toContain("--- AUDIT CONTEXT ---");
    expect(userMsg).toContain("--- END AUDIT CONTEXT ---");
    expect(userMsg).toContain("auth middleware is missing from plan.");
    expect(userMsg).toContain("add a feature");
  });

  it("does not include AUDIT CONTEXT when auditFindings is undefined", async () => {
    await runAgentLoop({
      task: "add a feature",
      repoPath: "/tmp/fake",
      mode: "patch",
    });

    const userMsg = capturedUserMessage();
    expect(userMsg).not.toContain("--- AUDIT CONTEXT ---");
    // mode tag is present (explicit mode: "patch") but no audit block
    expect(userMsg).toContain("add a feature");
    expect(userMsg).not.toContain("Findings:");
  });

  it("interpolates cost, toolCallCount, and citationCount in Metadata line", async () => {
    await runAgentLoop({
      task: "fix the bug",
      repoPath: "/tmp/fake",
      mode: "patch",
      auditFindings: {
        summary: "No issues found.",
        citationCount: 5,
        toolCallCount: 12,
        costUsd: 0.1234,
      },
    });

    const userMsg = capturedUserMessage();
    expect(userMsg).toContain("$0.1234");
    expect(userMsg).toContain("tool_calls=12");
    expect(userMsg).toContain("citations=5");
  });

  it("places AUDIT CONTEXT after PRIOR RUN CONTEXT and before the task", async () => {
    await runAgentLoop({
      task: "fix the bug",
      repoPath: "/tmp/fake",
      mode: "patch",
      priorRunSummary: "Previous attempt failed.",
      auditFindings: {
        summary: "Scope looks correct.",
        citationCount: 2,
        toolCallCount: 4,
        costUsd: 0.05,
      },
    });

    const userMsg = capturedUserMessage();
    const priorIdx = userMsg.indexOf("PRIOR RUN CONTEXT");
    const auditIdx = userMsg.indexOf("AUDIT CONTEXT");
    const taskIdx = userMsg.lastIndexOf("fix the bug");
    expect(priorIdx).toBeGreaterThanOrEqual(0);
    expect(auditIdx).toBeGreaterThan(priorIdx);
    expect(taskIdx).toBeGreaterThan(auditIdx);
  });

  it("is byte-stable across two identical calls without auditFindings", async () => {
    const firstRun = async () => {
      mocks.createChatCompletion.mockClear();
      await runAgentLoop({ task: "stable task", repoPath: "/tmp/stable", mode: "patch" });
      return capturedUserMessage();
    };
    const msg1 = await firstRun();
    const msg2 = await firstRun();
    expect(msg1).toBe(msg2);
  });
});

// ── Step B: structured sections, system prompt directive, cache prefix ─────────

describe("audit handoff — Step B structured AUDIT CONTEXT", () => {
  beforeEach(() => {
    mocks.createChatCompletion.mockClear();
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
    mocks.createChatCompletion.mockResolvedValue(textResponse("Done."));
    mocks.getUsage.mockResolvedValue(makeUsageAggregate(0));
    mocks.readDailyUsdCapOverride.mockReturnValue(undefined);
  });

  it("renders all structured sections when all new fields are populated", async () => {
    await runAgentLoop({
      task: "refactor auth",
      repoPath: "/tmp/fake",
      mode: "patch",
      auditFindings: {
        summary: "auth.ts needs update.",
        citationCount: 2,
        toolCallCount: 5,
        costUsd: 0.02,
        scopeVerdict: "under_scope",
        severity: "major",
        citations: [{ file: "src/auth.ts", line: 42 }, { file: "src/middleware.ts" }],
        filesAlreadyRead: ["src/auth.ts", "src/middleware.ts", "src/utils.ts"],
      },
    });

    const userMsg = capturedUserMessage();
    expect(userMsg).toContain("Verdict: under_scope | Severity: major");
    expect(userMsg).toContain("Files already investigated");
    expect(userMsg).toContain("- src/auth.ts");
    expect(userMsg).toContain("- src/utils.ts");
    expect(userMsg).toContain("Cited evidence:");
    expect(userMsg).toContain("- src/auth.ts:42");
    expect(userMsg).toContain("- src/middleware.ts");
  });

  it("renders without structured sections when only legacy fields are set", async () => {
    await runAgentLoop({
      task: "fix bug",
      repoPath: "/tmp/fake",
      mode: "patch",
      auditFindings: {
        summary: "Legacy summary.",
        citationCount: 1,
        toolCallCount: 3,
        costUsd: 0.01,
      },
    });

    const userMsg = capturedUserMessage();
    expect(userMsg).toContain("--- AUDIT CONTEXT ---");
    expect(userMsg).toContain("Legacy summary.");
    expect(userMsg).not.toContain("Verdict:");
    expect(userMsg).not.toContain("Files already investigated");
    expect(userMsg).not.toContain("Cited evidence:");
  });

  it("system prompt includes TRUST_PHASE1_DIRECTIVE when auditFindings is set", async () => {
    await runAgentLoop({
      task: "fix auth",
      repoPath: "/tmp/fake",
      mode: "patch",
      auditFindings: {
        summary: "Found issues.",
        citationCount: 1,
        toolCallCount: 4,
        costUsd: 0.01,
      },
    });

    const sysMsg = capturedSystemMessage();
    expect(sysMsg).toContain("=== AUDIT CONTEXT IS AUTHORITATIVE ===");
    expect(sysMsg).toContain("=== END AUDIT CONTEXT GUIDANCE ===");
  });

  it("system prompt does NOT include TRUST_PHASE1_DIRECTIVE when auditFindings is undefined", async () => {
    await runAgentLoop({
      task: "fix auth",
      repoPath: "/tmp/fake",
      mode: "patch",
    });

    const sysMsg = capturedSystemMessage();
    expect(sysMsg).not.toContain("=== AUDIT CONTEXT IS AUTHORITATIVE ===");
  });

  it("assembleAgentSystemPrompt without auditFindings is byte-identical regardless of param presence", () => {
    const baseArgs = {
      agentIntro: "You are a coding agent.",
      frameworkLines: [] as string[],
      hasFramework: false,
      projectMemoryBlock: "",
      baseMaxIterations: 15,
      canRunCommand: true,
      backgroundCommandBlock: "",
      repoPath: "/tmp/repo",
    };
    const withoutParam = assembleAgentSystemPrompt(baseArgs);
    const withUndefined = assembleAgentSystemPrompt({ ...baseArgs, auditFindings: undefined });
    expect(withoutParam).toBe(withUndefined);
    expect(withoutParam).not.toContain("AUDIT CONTEXT IS AUTHORITATIVE");
  });
});
