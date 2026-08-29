/**
 * The MCP approval gate — ENFORCEMENT, which is a different claim from derivation.
 *
 * `mcpClientManager.test.ts` pins which tools the gate should stop (`requiresApproval`). This file
 * pins that the dispatch arm actually stops them. A tool correctly derived as `requiresApproval:
 * true` and then dispatched anyway would pass every test in that file and none in this one — the
 * gap ledger item 408 recorded was never about classification, it was about the call going through
 * ungated.
 *
 * WHERE THE GATE SITS. Inside the `mcp__` dispatch arm of `agentLoop.ts`, which is reached only
 * AFTER user PreToolUse hooks have run — so a user hook still vetoes first and this gate is never
 * consulted in that case. It does not duplicate or interfere with them.
 *
 * Driven through the mocked-SDK harness, so it costs nothing to run.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import { registerTool } from "../tools/toolRegistry.js";

// ── hoisted mocks ─────────────────────────────────────────────────────────────

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

const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  requestCommandApproval: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

// The gate imports this lazily at the call site; mocking the module intercepts it either way.
vi.mock("../api/commandApprovals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/commandApprovals.js")>();
  return { ...actual, requestCommandApproval: mocks.requestCommandApproval };
});

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";

// ── MCP fixtures ──────────────────────────────────────────────────────────────

const SERVER = "testsrv";
const GATED = `mcp__${SERVER}__browser_click`;
const UNGATED = `mcp__${SERVER}__browser_snapshot`;

function registerMcpTool(name: string): void {
  registerTool({
    name,
    capabilities: ["mcp.call"],
    definition: {
      type: "function",
      function: { name, description: `[MCP:${SERVER}] test`, parameters: { type: "object", properties: {} } },
    } as ChatCompletionTool,
  });
}

/** Minimal manager stand-in: the gate reads `requiresApproval`, the dispatch calls `callTool`. */
function fakeMcpManager(gatedNames: string[]) {
  return {
    registeredToolNames: () => [GATED, UNGATED],
    requiresApproval: (n: string) => gatedNames.includes(n),
    callTool: mocks.callTool,
  } as unknown as import("../mcp/mcpClientManager.js").McpClientManager;
}

// callTool lives on `mocks` so vi.clearAllMocks resets it with the rest.
Object.assign(mocks, { callTool: vi.fn() });
const callTool = (mocks as unknown as { callTool: ReturnType<typeof vi.fn> }).callTool;

// ── harness ───────────────────────────────────────────────────────────────────

function toolCallResponse(toolName: string) {
  return {
    id: "msg-1",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call-1", type: "function", function: { name: toolName, arguments: "{}" } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function doneResponse() {
  return {
    id: "msg-2",
    model: "gpt-4o",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "[ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

let repoPath: string;
/** Every tool result fed back to the model, in order. */
let toolResults: Array<{ name: string; success: boolean; output: string }>;

async function runCalling(toolName: string, gatedNames: string[]) {
  let turn = 0;
  mocks.createChatCompletion.mockImplementation(async () => {
    turn += 1;
    return turn === 1 ? toolCallResponse(toolName) : doneResponse();
  });

  return runAgentLoop({
    task: "use the browser",
    repoPath,
    runId: "run-mcp-gate",
    mcpManager: fakeMcpManager(gatedNames),
    onToolResult: (name: string, result: { success: boolean; output: string }) => {
      toolResults.push({ name, success: result.success, output: result.output });
    },
  });
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-mcp-gate-"));
  resetToolExecutorMock(toolExecutorMock);
  vi.clearAllMocks();
  toolResults = [];
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "ok" });
  callTool.mockResolvedValue({ success: true, output: "clicked" });
  registerMcpTool(GATED);
  registerMcpTool(UNGATED);
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("the MCP approval gate is enforced, not merely derived", () => {
  it("T-GATE-DENIED: a denied gated call never reaches callTool and returns a structured refusal", async () => {
    mocks.requestCommandApproval.mockResolvedValue({ approvalId: "a1", approved: false });

    await runCalling(GATED, [GATED]);

    // THE POINT OF THE GATE. Derivation without this is classification, not enforcement.
    expect(callTool, "a denied MCP call must never reach the server").not.toHaveBeenCalled();

    const result = toolResults.find((r) => r.name === GATED);
    expect(result, "the model must get a result it can act on, not a crash").toBeDefined();
    expect(result!.success).toBe(false);
    expect(result!.output).toContain("mcp_approval_denied");
  });

  it("T-GATE-APPROVED: an approved gated call proceeds to callTool exactly once", async () => {
    mocks.requestCommandApproval.mockResolvedValue({ approvalId: "a1", approved: true });

    await runCalling(GATED, [GATED]);

    expect(mocks.requestCommandApproval).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(GATED, {});
  });

  it("T-GATE-UNGATED: a read-only tool is dispatched with no approval requested at all", async () => {
    // The floor. Without this, a gate that fired on EVERY call would pass both tests above for
    // entirely the wrong reason, and the read-only half of the design would be untested.
    mocks.requestCommandApproval.mockResolvedValue({ approvalId: "a1", approved: true });

    await runCalling(UNGATED, [GATED]);

    expect(mocks.requestCommandApproval).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith(UNGATED, {});
  });

  it("T-GATE-DISPLAY: the approval carries the tool name first, so [T]rust scopes to that tool", async () => {
    // The modal derives its trust prefix as command.split(/\s+/)[0]. Putting the tool name first
    // is what makes one [T]rust cover that tool for the project, and is why no new trust mechanism
    // was needed. A display string that led with anything else would silently trust the wrong thing.
    mocks.requestCommandApproval.mockResolvedValue({ approvalId: "a1", approved: true });

    await runCalling(GATED, [GATED]);

    const [arg] = mocks.requestCommandApproval.mock.calls[0]!;
    const command = String((arg as { command?: string }).command ?? "");
    expect(command.split(/\s+/)[0]).toBe(GATED);
    expect((arg as { kind?: string }).kind).toBe("mcp");
  });

  it("T-GATE-MARKER: a gate decision is recorded, not silent", async () => {
    mocks.requestCommandApproval.mockResolvedValue({ approvalId: "a1", approved: false });

    await runCalling(GATED, [GATED]);

    const call = mocks.log.mock.calls.find((c) => String(c[0]).includes("zone-mcp-approval"));
    expect(call, "a gate that leaves no trace cannot be audited after the fact").toBeDefined();
    const payload = JSON.parse(String(call![1])) as Record<string, unknown>;
    expect(payload["event"]).toBe("decision");
    expect(payload["tool"]).toBe(GATED);
    expect(payload["approved"]).toBe(false);
  });
});
