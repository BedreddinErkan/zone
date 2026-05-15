/**
 * Phase AS.0 — scopeJudge tests.
 * Three golden judge prompt scenarios: under-scope, over-scope, no-mismatch.
 * Also tests graceful fallback on LLM error.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ExecutionPlan } from "./executionPlan.js";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  log: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("./openaiClient.js", () => ({
  getModelName: vi.fn(() => "claude-sonnet-4-6"),
  getInferenceMode: vi.fn(() => "standard"),
}));

vi.mock("./openaiContext.js", () => ({
  getRequestContext: vi.fn(() => null),
  withRequestContext: vi.fn((_: unknown, fn: () => unknown) => fn()),
  attachRunIdentity: vi.fn(),
}));

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: mocks.debugLog,
  errorLog: vi.fn(),
}));

import { runScopeJudge } from "./scopeJudge.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const PLAN: ExecutionPlan = {
  objective: "Add a login button to the UI",
  steps: [
    { title: "Add LoginButton component", description: "Create the component", filesLikely: ["src/components/LoginButton.tsx"] },
    { title: "Wire into App", description: "Import in App.tsx", filesLikely: ["src/App.tsx"] },
  ],
  riskHints: ["Auth flow may be affected"],
  scopeSummary: "UI-only: LoginButton component + App wiring",
};

function llmResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 200, completion_tokens: 80, total_tokens: 280 },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("runScopeJudge — under_scope", () => {
  beforeEach(() => { mocks.log.mockClear(); mocks.debugLog.mockClear(); });

  it("returns mismatch=true, type=under_scope when LLM finds missing files", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      llmResponse(JSON.stringify({
        mismatch: true,
        type: "under_scope",
        reason: "Investigation shows auth middleware (src/middleware/auth.ts) must be updated for login to work, but it is absent from the plan.",
        revisedPlan: "Add LoginButton, wire App, update auth middleware.",
        missingFiles: ["src/middleware/auth.ts"],
      }))
    );

    const result = await runScopeJudge({ originalPlan: PLAN, findings: "Found auth middleware at src/middleware/auth.ts that needs updating.", runId: "test-1" });

    expect(result.mismatch).toBe(true);
    expect(result.type).toBe("under_scope");
    expect(result.missingFiles).toContain("src/middleware/auth.ts");
    expect(typeof result.reason).toBe("string");
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe("runScopeJudge — over_scope", () => {
  beforeEach(() => { mocks.log.mockClear(); mocks.debugLog.mockClear(); });

  it("returns mismatch=true, type=over_scope when plan lists uninvolved files", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      llmResponse(JSON.stringify({
        mismatch: true,
        type: "over_scope",
        reason: "Investigation shows src/App.tsx has no dependency on the login flow — it routes via Router, not App directly.",
        revisedPlan: "Only create LoginButton.tsx.",
        unnecessaryFiles: ["src/App.tsx"],
      }))
    );

    const result = await runScopeJudge({ originalPlan: PLAN, findings: "App.tsx delegates routing — LoginButton is standalone.", runId: "test-2" });

    expect(result.mismatch).toBe(true);
    expect(result.type).toBe("over_scope");
    expect(result.unnecessaryFiles).toContain("src/App.tsx");
  });
});

describe("runScopeJudge — no mismatch", () => {
  beforeEach(() => { mocks.log.mockClear(); mocks.debugLog.mockClear(); });

  it("returns mismatch=false when plan aligns with findings", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      llmResponse(JSON.stringify({
        mismatch: false,
        type: "none",
        reason: "Plan correctly identifies LoginButton.tsx and App.tsx as the only files involved.",
      }))
    );

    const result = await runScopeJudge({ originalPlan: PLAN, findings: "Only LoginButton.tsx and App.tsx are involved.", runId: "test-3" });

    expect(result.mismatch).toBe(false);
    expect(result.type).toBe("none");
    expect(result.missingFiles).toBeUndefined();
    expect(result.unnecessaryFiles).toBeUndefined();
  });

  it("emits zone-scope-judge debugLog on success", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      llmResponse(JSON.stringify({ mismatch: false, type: "none", reason: "Looks good." }))
    );

    await runScopeJudge({ originalPlan: PLAN, findings: "All good.", runId: "telem-test" });

    const logCall = mocks.debugLog.mock.calls.find((c: unknown[]) => c[0] === "[zone-scope-judge]");
    expect(logCall).toBeDefined();
    const payload = JSON.parse(String(logCall![1]));
    expect(payload.runId).toBe("telem-test");
    expect(payload.mismatch).toBe(false);
  });
});

describe("runScopeJudge — graceful fallback", () => {
  beforeEach(() => { mocks.log.mockClear(); mocks.debugLog.mockClear(); });

  it("returns mismatch=false on LLM error (never blocks execution)", async () => {
    mocks.createChatCompletion.mockRejectedValueOnce(new Error("LLM timeout"));

    const result = await runScopeJudge({ originalPlan: PLAN, findings: "some findings", runId: "fail-test" });

    expect(result.mismatch).toBe(false);
    expect(result.type).toBe("none");
  });

  it("returns mismatch=false on malformed JSON from LLM", async () => {
    mocks.createChatCompletion.mockResolvedValueOnce(
      llmResponse("Sorry, I can't answer that right now.")
    );

    const result = await runScopeJudge({ originalPlan: PLAN, findings: "some findings" });

    expect(result.mismatch).toBe(false);
  });
});
