/**
 * Item 169 — `assembleAgentSystemPrompt`'s wiring, for the three fields mutation testing
 * confirmed as real gaps (`hasFramework`, `qaCommandTool`, `summaryFormat`): every existing
 * test either calls the assembler directly with a hand-picked value, or runs the loop without
 * asserting on these fields' effect. Every assertion here runs the real `runAgentLoop` and reads
 * the real captured system message, the same harness `agentLoop.readOnlySuppressionTelemetry.test.ts`
 * already uses for the fields mutation testing found already covered.
 *
 * `archetype`, `answerOnly`, `planApproved`, `offeredToolNames`, and `baseMaxIterations` are
 * deliberately absent — the first four are covered elsewhere (see that file, and
 * `agentLoop.grantAtLoopEntry.test.ts`); `baseMaxIterations` is a declared field the assembler
 * never reads at all (item 169's own establish work) — no test could meaningfully cover it, and
 * adding one here would assert nothing real.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetToolExecutorMock } from "../test/fixtures/toolExecutorMock.js";
import type { TaskClassification } from "./taskClassifier.js";
import type { ProjectFramework } from "../repo/detectFramework.js";
import { READ_ONLY_CAPABILITIES } from "../tools/capabilities.js";

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
}));

const mockLog = vi.hoisted(() => vi.fn());

vi.mock("./factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
}));

vi.mock("../tools/toolExecutor.js", () => toolExecutorMock);
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/logger.js")>();
  return { ...actual, log: mockLog };
});

import { runAgentLoop } from "./agentLoop.js";

type CapturedMessage = { role: string; content: unknown };

function makeDoneResponse(text = "Task complete.") {
  return {
    choices: [{ message: { content: text, tool_calls: null }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function classification(
  archetype: TaskClassification["archetype"],
  tier: TaskClassification["tier"] = "complex"
): TaskClassification {
  return {
    tier,
    estimatedFiles: 2,
    estimatedIterations: 5,
    confidence: 0.9,
    classifierCostUsd: 0.002,
    classifierLatencyMs: 1000,
    classifierModel: "claude-haiku-4-5",
    fallbackUsed: false,
    archetype,
    archetypeConfidence: 0.9,
  };
}

const FIXTURE_FRAMEWORK: ProjectFramework = {
  language: "typescript",
  framework: "React",
  testCommand: "npm test",
  buildCommand: "npm run build",
  devCommand: "npm run dev",
  packageManager: "npm",
  hasTests: true,
  testFilesDetected: true,
  testFramework: "vitest",
  configFiles: [],
  subProjects: [],
};

let repoPath: string;
let messages: CapturedMessage[];

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-prompt-wiring-"));
  resetToolExecutorMock(toolExecutorMock);
  mocks.createChatCompletion.mockReset();
  mockLog.mockReset();
  toolExecutorMock.executeTool.mockResolvedValue({ success: true, output: "" });
  messages = [];
  mocks.createChatCompletion.mockImplementationOnce(async (params: { messages: CapturedMessage[] }) => {
    messages = params.messages;
    return makeDoneResponse();
  });
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

function systemText(): string {
  const systemMsg = messages.find((m) => m.role === "system");
  expect(systemMsg).toBeDefined();
  return String(systemMsg!.content);
}

describe("assembleAgentSystemPrompt wiring — the real loop, not a hand-built input (item 169)", () => {
  it("hasFramework: a run with a detected framework renders the framework block (agentIntro's own 'working on a X project' clause is a separate field — this pins hasFramework specifically)", async () => {
    await runAgentLoop({
      task: "add a helper",
      repoPath,
      taskClassification: classification("targeted_fix"),
      framework: FIXTURE_FRAMEWORK,
      maxIterationsOverride: 3,
    });
    expect(systemText()).toContain("## Project framework");
  });

  it("hasFramework: a run with no detected framework renders no framework block (the other direction of the same pin)", async () => {
    await runAgentLoop({
      task: "add a helper",
      repoPath,
      taskClassification: classification("targeted_fix"),
      maxIterationsOverride: 3,
    });
    expect(systemText()).not.toContain("## Project framework");
  });

  it("qaCommandTool: a read-only capability filter (shell.exec without fs.write — what the archetype dispatcher itself sets for question/investigation) names run_command_readonly, not run_command", async () => {
    await runAgentLoop({
      task: "what does this function do",
      repoPath,
      taskClassification: classification("question", "medium"),
      capabilityFilter: { allow: READ_ONLY_CAPABILITIES },
      maxIterationsOverride: 3,
    });
    const text = systemText();
    expect(text).toContain("via run_command_readonly");
    expect(text).not.toContain("via run_command (");
  });

  it("qaCommandTool: a full-capability run (the default) names run_command, not run_command_readonly — the other direction of the same pin", async () => {
    await runAgentLoop({
      task: "what does this function do",
      repoPath,
      taskClassification: classification("question", "medium"),
      maxIterationsOverride: 3,
    });
    const text = systemText();
    expect(text).toContain("via run_command (");
    expect(text).not.toContain("via run_command_readonly");
  });

  it("summaryFormat: detailed threads the wider token range and char cap into the real prompt", async () => {
    await runAgentLoop({
      task: "add a helper",
      repoPath,
      taskClassification: classification("targeted_fix"),
      summaryFormat: "detailed",
      maxIterationsOverride: 3,
    });
    expect(systemText()).toContain("Token budget: 300-500 tokens; hard cap 2500 characters.");
  });

  it("summaryFormat: compact (the default) threads the narrower pair — the other direction of the same pin", async () => {
    await runAgentLoop({
      task: "add a helper",
      repoPath,
      taskClassification: classification("targeted_fix"),
      maxIterationsOverride: 3,
    });
    expect(systemText()).toContain("Token budget: 150-300 tokens; hard cap 900 characters.");
  });
});
