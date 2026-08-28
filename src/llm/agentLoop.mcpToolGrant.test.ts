/**
 * An approved MCP server's tools must reach the model in every pipeline.
 *
 * Before this suite's fix, MCP tools survived only when NO allow-shaped filter was present —
 * `resolveToolList` grants everything when `hasAllowFilter` is false, and every allow-shaped filter
 * excluded them: `mcp.call` is in no allow-set that is ever used, and the tier subsets are literal
 * name lists fixed at authoring time, so an `mcp__<server>__<tool>` name cannot be in them. The one
 * combination that worked (complex tier + a write archetype) was the ABSENCE of a filter rather than
 * a designed permission — measured live across five runs, recorded as Q10 of
 * `docs/locator-discovery-investigation.md`.
 *
 * The rule these tests pin: declaring a server and approving it at the trust gate IS the permission.
 * A task-shape filter narrows Zone's OWN toolset and must not silently override it.
 *
 * WHAT GATES THE GRANT — read this before changing the tests. Not tier, not archetype, and not
 * `isSubagentLoop`, but `input.mcpManager`: the manager is the only thing that can ROUTE an `mcp__`
 * call (agentLoop's own dispatch branch checks `name.startsWith("mcp__") && input.mcpManager`, and
 * `executeTool` has no `mcp__` branch at all). So the loop offers exactly what it can execute, and
 * never a tool it would fail on. Subagents get no manager — `toolExecutor`'s sole spawn site omits
 * it — which is why T-4 below passes structurally rather than by a name check.
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
import { SIMPLE_TIER_TOOLS } from "../tools/tierToolSubsets.js";
import type { TaskClassification } from "./taskClassifier.js";

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
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);

vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

// ── imports under test ────────────────────────────────────────────────────────

import { runAgentLoop } from "./agentLoop.js";
import { buildDispatcherCapabilityFilter, QUESTION_PIPELINE } from "./archetypeDispatcher.js";

// ── the MCP fixture ───────────────────────────────────────────────────────────

const MCP_SERVER = "testsrv";
const MCP_TOOL = `mcp__${MCP_SERVER}__browser_snapshot`;

/**
 * Registered EXACTLY as `mcpClientManager.connectOne` does — same namespaced name shape, same
 * single `mcp.call` capability, same definition shape. Deriving the fixture from the real producer
 * rather than hand-authoring a convenient one is what makes these assertions transfer: a fixture
 * that declared, say, `fs.read` would sail through the read-only filter for the wrong reason and
 * the suite would pass while production stayed broken.
 */
function registerFakeMcpTool(): void {
  registerTool({
    name: MCP_TOOL,
    capabilities: ["mcp.call"],
    definition: {
      type: "function",
      function: {
        name: MCP_TOOL,
        description: `[MCP:${MCP_SERVER}] Capture an accessibility snapshot.`,
        parameters: { type: "object", properties: {} },
      },
    } as ChatCompletionTool,
  });
}

/** Minimal stand-in for the real manager: the grant reads only `registeredToolNames()`. */
function fakeMcpManager(names: string[] = [MCP_TOOL]) {
  return { registeredToolNames: () => names } as unknown as import("../mcp/mcpClientManager.js").McpClientManager;
}

// ── harness ───────────────────────────────────────────────────────────────────

function makeDoneResponse() {
  return {
    choices: [
      {
        message: { content: "[ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

function makeClassification(tier: "simple" | "medium" | "complex"): TaskClassification {
  return {
    tier,
    confidence: 0.99,
    fallbackUsed: false,
    archetype: tier === "complex" ? "complex_multi_file" : "simple_add",
    archetypeConfidence: 0.99,
    estimatedFiles: tier === "complex" ? 5 : 1,
    estimatedIterations: tier === "complex" ? 15 : 3,
    classifierCostUsd: 0,
    classifierLatencyMs: 0,
    classifierModel: "test",
  };
}

let repoPath: string;
/** Tool names in the array actually handed to the adapter — the model-facing list. */
let offered: string[] | undefined;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-mcp-tool-grant-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.log.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });

  offered = undefined;
  mocks.createChatCompletion.mockImplementation(
    async (params: { tools?: Array<{ function: { name: string } }> }) => {
      offered ??= params.tools?.map((t) => t.function.name);
      return makeDoneResponse();
    }
  );

  registerFakeMcpTool();
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

// ── T-1: the read-only archetype — the case the whole change exists for ───────

describe("an approved MCP server's tools reach a read-only archetype", () => {
  it("T-1: question/investigation (allow: READ_ONLY_CAPABILITIES) is offered the mcp__ tool", async () => {
    // The production filter, not a copy of it — a hand-built `{allow:{fs.read,shell.exec}}` would
    // keep passing if the dispatcher's own shape changed underneath it.
    const readOnlyFilter = buildDispatcherCapabilityFilter(QUESTION_PIPELINE);
    expect(readOnlyFilter?.allow, "QUESTION_PIPELINE must still be allow-shaped for this to test anything").toBeDefined();

    await runAgentLoop({
      task: "what does this page contain?",
      repoPath,
      runId: "run-mcp-readonly",
      capabilityFilter: readOnlyFilter,
      mcpManager: fakeMcpManager(),
    });

    expect(offered, "no tool array reached the adapter — the pin has nothing to observe").toBeDefined();
    // THE FIX, PINNED. `mcp.call` is in no allow-set anywhere, so before the grant this name could
    // not survive a capability-allow filter by any route.
    expect(offered!).toContain(MCP_TOOL);
    // The cage itself must be intact — the grant widens by name, it does not lift the allow-set.
    expect(offered!).not.toContain("write_file");
    expect(offered!).not.toContain("apply_patch");
    expect(offered!).not.toContain("run_command");
  });

  it("T-2: the grant is reported, not silent — [zone-mcp-tools-granted] names what it added", async () => {
    await runAgentLoop({
      task: "what does this page contain?",
      repoPath,
      runId: "run-mcp-marker",
      capabilityFilter: buildDispatcherCapabilityFilter(QUESTION_PIPELINE),
      mcpManager: fakeMcpManager(),
    });

    const call = mocks.log.mock.calls.find((c) => String(c[0]).includes("zone-mcp-tools-granted"));
    expect(call, "the withholding was silent before; the grant must not be").toBeDefined();
    const payload = JSON.parse(String(call![1])) as Record<string, unknown>;
    expect(payload["granted"]).toEqual([MCP_TOOL]);
    expect(payload["filterSource"]).toBe("capabilityFilter");
  });
});

// ── T-3: the other allow shape — a tier name-whitelist ────────────────────────

describe("an approved MCP server's tools survive the tier subset too", () => {
  it("T-3: tier simple (allowToolNames) is offered the mcp__ tool alongside its five", async () => {
    await runAgentLoop({
      task: "add a jsdoc comment",
      repoPath,
      runId: "run-mcp-simple-tier",
      taskClassification: makeClassification("simple"),
      mcpManager: fakeMcpManager(),
    });

    expect(offered).toBeDefined();
    // Separate assertion from T-1 because the two allow shapes fail for DIFFERENT reasons inside
    // resolveToolList: `allow` misses on the capability check, `allowToolNames` misses on the name
    // check. One passing tells you nothing about the other.
    expect(offered!).toContain(MCP_TOOL);
    for (const name of SIMPLE_TIER_TOOLS) expect(offered!).toContain(name);
    // Still the simple tier — the grant adds MCP, it does not promote the tier.
    expect(offered!).not.toContain("search_in_files");
    expect(offered!).not.toContain("Task");
  });
});

// ── T-4: the subagent axis, which is deliberately NOT changed ─────────────────

describe("subagents remain excluded — a separate axis, left as it is", () => {
  it("T-4: a subagent loop is offered no mcp__ tool, because it has no manager to route one", async () => {
    // Mirrors production exactly: toolExecutor's sole spawn site passes a capabilityFilter and
    // omits mcpManager. Offering a tool here would be offering one the loop cannot execute —
    // agentLoop's dispatch falls through to executeTool, which has no mcp__ branch.
    await runAgentLoop({
      task: "read two files and summarise",
      repoPath,
      runId: "run-mcp-subagent",
      subagent: { id: "sub-1", type: "explore", parentRunId: "run-mcp-subagent" },
      capabilityFilter: { allow: new Set(["fs.read"] as const) },
    });

    expect(offered).toBeDefined();
    expect(offered!).not.toContain(MCP_TOOL);
  });
});

// ── T-5/T-6: the two ways this change could have broken something ─────────────

describe("the grant cannot collapse or override", () => {
  it("T-5: with no allow-filter at all, the grant is a no-op and the full toolset survives", async () => {
    // The failure mode archetypeDispatcher documents: introducing allowToolNames where NEITHER
    // allow nor allowToolNames existed flips resolveToolList's hasAllowFilter false->true, and with
    // no capability allow-set only the named tools resolve — collapsing the offered set instead of
    // widening it. Complex tier returns `undefined` from tierToolFilter, so this is that exact case.
    await runAgentLoop({
      task: "large multi-file refactor",
      repoPath,
      runId: "run-mcp-no-filter",
      taskClassification: makeClassification("complex"),
      mcpManager: fakeMcpManager(),
    });

    expect(offered).toBeDefined();
    expect(offered!).toContain(MCP_TOOL);
    // A collapse would leave ONLY the mcp name. These are the tools complex tier already had.
    expect(offered!).toContain("search_in_files");
    expect(offered!).toContain("read_file");
    expect(offered!).toContain("write_file");
    expect(offered!.length).toBeGreaterThan(SIMPLE_TIER_TOOLS.size);
  });

  it("T-6: deny still wins — an explicitly excluded mcp__ name stays out", async () => {
    // Keeps the door open for the tool-level filtering pass that is deliberately NOT in this
    // change: the grant widens allowToolNames, and resolveToolList checks excludeToolNames first.
    await runAgentLoop({
      task: "what does this page contain?",
      repoPath,
      runId: "run-mcp-denied",
      capabilityFilter: {
        ...buildDispatcherCapabilityFilter(QUESTION_PIPELINE),
        excludeToolNames: new Set([MCP_TOOL]),
      },
      mcpManager: fakeMcpManager(),
    });

    expect(offered).toBeDefined();
    expect(offered!).not.toContain(MCP_TOOL);
  });
});
