/**
 * Phase X.0.1 — audit handoff user-message injection tests.
 * Validates: AUDIT CONTEXT block renders in the user message sent to the LLM,
 * is absent when auditFindings is undefined, and interpolates cost/citations correctly.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  executeTool: vi.fn(),
  withStagingTempFlush: vi.fn(),
  log: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
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
}));

import { runAgentLoop } from "./agentLoop.js";

// ── helpers ───────────────────────────────────────────────────────────────────

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

// ── tests ─────────────────────────────────────────────────────────────────────

describe("audit handoff — AUDIT CONTEXT user-message injection", () => {
  beforeEach(() => {
    mocks.createChatCompletion.mockClear();
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
    mocks.createChatCompletion.mockResolvedValue(textResponse("Done."));
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

  it("interpolates cost, toolCallCount, and citationCount correctly", async () => {
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
    expect(userMsg).toContain("12 tool calls");
    expect(userMsg).toContain("5 citations");
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
