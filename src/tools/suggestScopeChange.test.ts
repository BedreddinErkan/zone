/**
 * Phase AS.0 — suggest_scope_change tool tests.
 * Validates: schema presence in AUDIT_ONLY_TOOLS, tool unavailability outside
 * audit phase (not in ZONE_TOOLS), and handler dispatch via investigateScope.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { AUDIT_ONLY_TOOLS, ZONE_TOOLS } from "./toolDefinitions.js";

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

vi.mock("./toolExecutor.js", () => ({
  executeTool: mocks.executeTool,
  withStagingTempFlush: mocks.withStagingTempFlush,
}));

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: mocks.debugLog,
  errorLog: vi.fn(),
}));

import { investigateScope } from "../llm/investigationFlow.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function textResponse(content: string) {
  return {
    choices: [{ message: { content, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  };
}

function toolCallResponse(name: string, args: Record<string, unknown>, id = "tc-1") {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

// ── schema tests ──────────────────────────────────────────────────────────────

describe("suggest_scope_change — schema", () => {
  it("is present in AUDIT_ONLY_TOOLS", () => {
    const tool = AUDIT_ONLY_TOOLS.find((t) => t.function.name === "suggest_scope_change");
    expect(tool).toBeDefined();
    expect(tool!.type).toBe("function");
  });

  it("is NOT present in ZONE_TOOLS (unavailable in execute mode)", () => {
    const tool = ZONE_TOOLS.find((t) => t.function.name === "suggest_scope_change");
    expect(tool).toBeUndefined();
  });

  it("schema has required fields: reason, type, revised_plan_summary", () => {
    const tool = AUDIT_ONLY_TOOLS.find((t) => t.function.name === "suggest_scope_change")!;
    const params = tool.function.parameters as Record<string, unknown>;
    const required = params["required"] as string[];
    expect(required).toContain("reason");
    expect(required).toContain("type");
    expect(required).toContain("revised_plan_summary");
  });

  it("type enum includes under_scope, over_scope, mixed", () => {
    const tool = AUDIT_ONLY_TOOLS.find((t) => t.function.name === "suggest_scope_change")!;
    const props = (tool.function.parameters as Record<string, unknown>)["properties"] as Record<string, unknown>;
    const typeEnum = (props["type"] as Record<string, unknown>)["enum"] as string[];
    expect(typeEnum).toContain("under_scope");
    expect(typeEnum).toContain("over_scope");
    expect(typeEnum).toContain("mixed");
  });
});

// ── handler tests via investigateScope ───────────────────────────────────────

describe("suggest_scope_change — handler via investigateScope", () => {
  beforeEach(() => {
    mocks.log.mockClear();
    mocks.debugLog.mockClear();
    mocks.executeTool.mockResolvedValue({ success: true, output: "ok" });
    mocks.withStagingTempFlush.mockImplementation((_: unknown, fn: () => unknown) => fn());
  });

  it("captures agentSuggestedRevision when agent calls suggest_scope_change", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(
        toolCallResponse("suggest_scope_change", {
          type: "under_scope",
          reason: "Found auth middleware not in plan.",
          missing_files: ["src/middleware/auth.ts"],
          revised_plan_summary: "Also update auth middleware.",
        })
      )
      .mockResolvedValueOnce(textResponse("Investigation complete. Auth middleware is missing from plan."));

    const result = await investigateScope({
      repoPath: "/tmp/fake",
      query: "Are there missing files?",
    });

    expect(result.agentSuggestedRevision).toBeDefined();
    expect(result.agentSuggestedRevision!.type).toBe("under_scope");
    expect(result.agentSuggestedRevision!.missingFiles).toContain("src/middleware/auth.ts");
    expect(result.agentSuggestedRevision!.reason).toMatch(/auth/i);
  });

  it("emits debugLog zone-scope-revision-proposed marker when tool is called", async () => {
    mocks.createChatCompletion
      .mockResolvedValueOnce(
        toolCallResponse("suggest_scope_change", {
          type: "over_scope",
          reason: "Plan touches unrelated file.",
          unnecessary_files: ["src/unrelated/thing.ts"],
          revised_plan_summary: "Skip unrelated file.",
        })
      )
      .mockResolvedValueOnce(textResponse("Done."));

    await investigateScope({ repoPath: "/tmp/fake", query: "scope check" });

    const markerCall = mocks.debugLog.mock.calls.find(
      (c: unknown[]) => c[0] === "[zone-scope-revision-proposed]"
    );
    expect(markerCall).toBeDefined();
    const payload = JSON.parse(String(markerCall![1]));
    expect(payload.type).toBe("over_scope");
    expect(payload.unnecessaryCount).toBe(1);
  });

  it("rejects missing required fields and returns failure ack to agent", async () => {
    // Agent sends invalid call (no revised_plan_summary), then fixes it
    mocks.createChatCompletion
      .mockResolvedValueOnce(
        toolCallResponse("suggest_scope_change", {
          type: "under_scope",
          reason: "Missing files found.",
          // missing: revised_plan_summary
        })
      )
      .mockResolvedValueOnce(textResponse("I see — missing files not listed."));

    const result = await investigateScope({ repoPath: "/tmp/fake", query: "check scope" });
    // Run completed; no revision captured (tool was rejected)
    expect(result.agentSuggestedRevision).toBeUndefined();
  });
});
