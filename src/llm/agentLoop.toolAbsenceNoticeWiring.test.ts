/**
 * Item 166 stage one. Mutation-testing gap found and closed: toolAbsenceNotice.test.ts
 * only calls buildToolAbsenceBlock directly with explicit allowToolRequest values — it
 * never exercises agentLoop.ts's actual wiring decision (`allowToolRequest:
 * isInvestigationMode && input.allowToolRequest === true`). A mutation that hardcodes
 * that call to `true` unconditionally
 * survived every existing test file (agentLoop.prompts.test.ts, .tierToolSubset.test.ts,
 * .writeCapabilityAbsent.test.ts) — none of them capture the real system prompt text
 * from a live runAgentLoop call. This file closes that gap: real runAgentLoop, mocked
 * LLM client, captures the actual system message content per mode.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { Capability } from "../tools/capabilities.js";

/** Repo root, resolved from this file rather than from cwd, so the real-tree scan below
 *  reads the same tree regardless of where vitest is invoked from. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  pruneStaleReads: vi.fn(),
  emitContextPruned: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "openai",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));
vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);
vi.mock("./contextPruner.js", () => ({
  pruneStaleReads: mocks.pruneStaleReads,
  emitContextPruned: mocks.emitContextPruned,
}));
vi.mock("../utils/logger.js", () => ({
  log: mocks.log,
  debugLog: vi.fn(),
  errorLog: vi.fn(),
}));

import { runAgentLoop } from "./agentLoop.js";

function makeDoneResponse() {
  return {
    choices: [
      { message: { content: "[ZONE_VERIFICATION: no_verification_attempted]", tool_calls: null }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
  };
}

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-notice-wiring-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mocks.pruneStaleReads.mockReset();
  mocks.emitContextPruned.mockReset();
  mocks.log.mockReset();
  mocks.pruneStaleReads.mockImplementation((msgs: unknown[]) => ({
    pruned: msgs,
    stats: { blocksReplaced: 0, charsSaved: 0, blocksKept: (msgs as unknown[]).length },
  }));
  mocks.emitContextPruned.mockImplementation(() => {});
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function captureSystemContent(): { get: () => string | undefined } {
  let captured: string | undefined;
  mocks.createChatCompletion.mockImplementation(
    async (params: { messages?: Array<{ role: string; content: unknown }> }) => {
      const sys = params.messages?.find((m) => m.role === "system");
      captured = typeof sys?.content === "string" ? sys.content : JSON.stringify(sys?.content);
      return makeDoneResponse();
    }
  );
  return { get: () => captured };
}

const REDIRECTION = "name it in requestedTools in your plan JSON";

describe("item 166 stage one — allowToolRequest wiring at the real runAgentLoop call site", () => {
  it("execution mode (default): the assembled system prompt's notice has NO redirection", async () => {
    const capture = captureSystemContent();

    await runAgentLoop({
      task: "add a comment",
      repoPath,
      capabilityFilter: { allowToolNames: new Set(["read_file"]) },
    });

    const content = capture.get();
    expect(content).toBeDefined();
    expect(content).toContain("TOOLS NOT AVAILABLE THIS RUN");
    expect(content).not.toContain(REDIRECTION);
  });

  it("investigation mode WITH allowToolRequest: the assembled system prompt's notice DOES contain the redirection", async () => {
    // Knowingly edited: this test used to pass mode alone, pinning "the mode decides".
    // That was the defect — runInvestigationFlow shares the mode and cannot receive a
    // request. The un-flagged case is now pinned by its own test below.
    const capture = captureSystemContent();

    await runAgentLoop({
      task: "investigate how X works",
      repoPath,
      mode: "investigate",
      allowToolRequest: true,
      capabilityFilter: { allowToolNames: new Set(["read_file"]) },
    });

    const content = capture.get();
    expect(content).toBeDefined();
    expect(content).toContain("TOOLS NOT AVAILABLE THIS RUN");
    expect(content).toContain(REDIRECTION);
  });

  it("the /init shape — investigation mode WITHOUT the flag: notice renders, redirection does not", async () => {
    // runInvestigationFlow's own shape: investigation mode, a capability filter, and
    // no plan anywhere downstream. It must still be told what is withheld, and must
    // not be told to name anything in a plan JSON it never emits.
    const capture = captureSystemContent();

    await runAgentLoop({
      task: "summarise this repo",
      repoPath,
      mode: "investigate",
      capabilityFilter: { allow: new Set<Capability>(["fs.read"]) },
    });

    const content = capture.get();
    expect(content).toBeDefined();
    expect(content).toContain("TOOLS NOT AVAILABLE THIS RUN");
    expect(content).not.toContain(REDIRECTION);
  });

  it("execution mode WITH the flag set: still no redirection — the mode conjunct is load-bearing", async () => {
    const capture = captureSystemContent();

    await runAgentLoop({
      task: "add a comment",
      repoPath,
      allowToolRequest: true,
      capabilityFilter: { allowToolNames: new Set(["read_file"]) },
    });

    const content = capture.get();
    expect(content).toBeDefined();
    expect(content).toContain("TOOLS NOT AVAILABLE THIS RUN");
    expect(content).not.toContain(REDIRECTION);
  });
});

/**
 * The flag's own invariant, checked against the real tree rather than promised by a
 * doc comment. The property that makes the redirection honest — "this loop's output is
 * an ExecutionPlan a later loop reads" — is NOT derivable from anything runAgentLoop
 * receives: planInvestigation passes a strict subset of investigationFlow's fields, and
 * the only structural difference that tracks it lives inside the task string. So it is
 * asserted here instead, on the property and not merely on the identity: every
 * production call site passing the flag must sit in a file that also names
 * `requestedTools`, i.e. that defines the field the redirection points at.
 */
describe("item 166 — allowToolRequest's invariant, checked against the real tree", () => {
  /** Brace-balanced so a nested `})` inside a callback cannot truncate the call. */
  function runAgentLoopCalls(text: string): string[] {
    const out: string[] = [];
    let i = 0;
    while ((i = text.indexOf("runAgentLoop(", i)) !== -1) {
      let j = i + "runAgentLoop".length;
      let depth = 0;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") {
          depth--;
          if (depth === 0) { j++; break; }
        }
      }
      out.push(text.slice(i, j));
      i = j;
    }
    return out;
  }

  function productionSources(): string[] {
    return execSync('git ls-files "src/**/*.ts"', { encoding: "utf8", cwd: REPO_ROOT })
      .split("\n")
      .filter((f) => f && !/\.test\.ts$/.test(f));
  }

  function callSitesSettingTheFlag(): string[] {
    return productionSources().filter((f) =>
      runAgentLoopCalls(fs.readFileSync(path.join(REPO_ROOT, f), "utf8"))
        .some((call) => /\ballowToolRequest\s*:/.test(call))
    );
  }

  it("the scan finds runAgentLoop call sites at all — non-vacuity, before any absence is read from it", () => {
    const withCalls = productionSources().filter(
      (f) => runAgentLoopCalls(fs.readFileSync(path.join(REPO_ROOT, f), "utf8")).length > 0
    );
    expect(withCalls.length).toBeGreaterThanOrEqual(4);
    expect(withCalls).toContain("src/llm/planInvestigation.ts");
    expect(withCalls).toContain("src/llm/investigationFlow.ts");
  });

  it("exactly one production call site sets allowToolRequest, and it is the plan-emitting one", () => {
    expect(callSitesSettingTheFlag()).toEqual(["src/llm/planInvestigation.ts"]);
  });

  it("every call site setting the flag also names requestedTools — the property, not the identity", () => {
    const sites = callSitesSettingTheFlag();
    expect(sites.length).toBeGreaterThan(0);
    for (const f of sites) {
      const src = fs.readFileSync(path.join(REPO_ROOT, f), "utf8");
      expect(src, `${f} sets allowToolRequest but never names requestedTools`).toContain("requestedTools");
    }
  });

  it("runInvestigationFlow does not set it, and has no requestedTools to point at", () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, "src/llm/investigationFlow.ts"), "utf8");
    expect(src).not.toContain("allowToolRequest");
    expect(src).not.toContain("requestedTools");
  });
});
