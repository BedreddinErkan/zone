import { describe, it, expect, vi, beforeEach } from "vitest";

// gateway-support-investigation.md §2.4 site 10 — subagentDispatch.ts:124's
// `getRequestContext()?.provider ?? "openai"` — characterization, not endorsement. Mirrors the
// mocking convention toolExecutor.workerModel.test.ts already established for the identically
// shaped fallback at toolExecutor.ts:1117 (site 11). logSubagentDispatched is called from
// toolEventHandler/handleToolResult.ts, not from toolExecutor.ts, so executeTool cannot reach
// it — every existing test touching handleToolResult.ts mocks this function away entirely.
// logSubagentDispatched is exported and is this module's own public contract, so calling it
// directly is not a private-helper call.

const mocks = vi.hoisted(() => ({
  getRequestContext: vi.fn(),
  getModelForRole: vi.fn(),
}));

vi.mock("./openaiContext.js", () => ({
  getRequestContext: mocks.getRequestContext,
}));

vi.mock("./modelRouting.js", () => ({
  getModelForRole: mocks.getModelForRole,
}));

import { logSubagentDispatched } from "./subagentDispatch.js";

beforeEach(() => {
  mocks.getRequestContext.mockReset();
  mocks.getModelForRole.mockReset();
});

describe("logSubagentDispatched — dispatch-time provider fallback", () => {
  it("falls back to openai provider when request context has no provider set", () => {
    mocks.getRequestContext.mockReturnValue({});
    mocks.getModelForRole.mockReturnValue("gpt-5.4-mini");

    logSubagentDispatched(
      { subagent_type: "worker", description: "Reason: fix bug\nDo the thing." },
      "run-1",
      0
    );

    expect(mocks.getModelForRole).toHaveBeenCalledWith("worker", "openai");
  });

  it("uses the request context's provider when one is set", () => {
    mocks.getRequestContext.mockReturnValue({ provider: "anthropic" });
    mocks.getModelForRole.mockReturnValue("claude-haiku-4-5");

    logSubagentDispatched(
      { subagent_type: "worker", description: "Reason: fix bug\nDo the thing." },
      "run-1",
      0
    );

    expect(mocks.getModelForRole).toHaveBeenCalledWith("worker", "anthropic");
  });

  it("does not call getModelForRole for a non-worker subagent_type — the fallback's only effect is gated behind subagent_type === \"worker\"", () => {
    mocks.getRequestContext.mockReturnValue({});

    logSubagentDispatched(
      { subagent_type: "explore", description: "Reason: explore\nCheck the repo." },
      "run-1",
      0
    );

    expect(mocks.getModelForRole).not.toHaveBeenCalled();
  });
});
