/**
 * R3 Stage 2b — composition test.
 * Verifies the full dispatch → runLlmPatchFlow → runAgentLoop → staging → checkpoint → flush → disk path.
 * Only the LLM factory and a few infrastructure mocks are stubbed; real tool execution runs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the LLM factory. All other modules (runLlmPatchFlow, runAgentLoop, toolExecutor) run real.
const mocks = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("../llm/factory.js", () => ({
  createLLMClient: vi.fn(() => ({
    provider: "anthropic",
    createChatCompletion: mocks.createChatCompletion,
  })),
  ProviderRequestError: class ProviderRequestError extends Error {},
  PlanRefusalError: class PlanRefusalError extends Error {},
}));

// Suppress spinner and CLI output.
vi.mock("./sink.js", () => ({
  buildCliSink: vi.fn(() => ({ onProgress: vi.fn() })),
  createSpinner: vi.fn(() => ({ stop: vi.fn() })),
}));

// Skip task classification LLM call — return a fixed medium tier.
vi.mock("../llm/taskClassifier.js", () => ({
  classifyTask: vi.fn().mockResolvedValue({
    tier: "medium",
    archetype: "targeted_fix",
    archetypeConfidence: 0.9,
    confidence: 0.9,
    fallbackUsed: false,
  }),
  djb2Hash: (s: string) => s.length,
}));

// Pass-through context pruner (no stale-read eviction).

// Return planDepth: "investigate" so dispatch enters the checkpoint loop.
vi.mock("../api/diskModel.js", () => ({
  loadDiskModelSync: vi.fn(() => ({
    version: 2,
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    planDepth: "investigate",
    updatedAt: "",
  })),
}));

import { runOneShotInner } from "./dispatch.js";
import { installScript, scriptText, scriptToolCall, scriptDone } from "../test/fixtures/scriptedLlm.js";
import { resolveStagedApproval } from "../api/stagedApprovals.js";
import type { LlmPatchProgressUpdate } from "../core/agentLifecycleEvents.js";
import type { ZoneStructuredProgressEvent } from "../core/agentLifecycleEvents.js";

let repoPath: string;

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-comp-"));
  // Trust gate: ZONE_TRUST_ALL=1 bypasses the interactive trust prompt.
  process.env["ZONE_TRUST_ALL"] = "1";
  mocks.createChatCompletion.mockReset();
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});

afterEach(() => {
  delete process.env["ZONE_TRUST_ALL"];
  vi.restoreAllMocks();
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("R3 Stage 2b — composition: dispatch → engine → staged-checkpoint → flush → disk", () => {
  it("investigate path with autoApprove:true: write_file on existing file stages, checkpoint fires, file flushed to disk", async () => {
    // Create an existing file so write_file goes through the staging path (not direct write).
    const targetFile = path.join(repoPath, "greeting.md");
    fs.writeFileSync(targetFile, "# Hello\n");

    // runLlmPatchFlow calls generateExecutionPlan internally before the agent loop.
    // Script call order:
    //   1. JSON plan response  → consumed by generateExecutionPlan
    //   2. write_file tool call → consumed by agent loop iter 0
    //   3. scriptDone() default → consumed by agent loop iter 1
    const planJson = JSON.stringify({
      objective: "Update greeting.md to say Hello World",
      steps: [{ title: "Update greeting.md", filesLikely: ["greeting.md"], subagentEligible: false }],
      riskHints: [],
      scopeSummary: "greeting.md",
    });
    installScript(mocks.createChatCompletion, [
      scriptText(`\`\`\`json\n${planJson}\n\`\`\``),
      scriptToolCall("write_file", { filePath: "greeting.md", content: "# Hello World\n" }),
    ]);

    const result = await runOneShotInner(
      "update the greeting to say Hello World",
      {
        model: "claude-sonnet-4-6",
        provider: "anthropic" as const,
        anthropicApiKey: "sk-ant-test",
        openaiApiKey: undefined,
        dailyUsdCap: 10,
        repoPath,
        forceTier: undefined,
        autoApprove: true,  // auto-resolves staged-diff checkpoint
        noRevision: false,
        verbose: false,
        quiet: true,
        noColor: true,
      },
      "comp-run-1",
      { mode: "plan", externalAc: new AbortController() }
    );

    // The run must complete (ok:true or ok:false but not hang).
    // With autoApprove the checkpoint resolves to approve_all → file is flushed.
    expect(result).toBeDefined();
    // The file on disk should contain the new content written by write_file.
    const onDisk = fs.readFileSync(targetFile, "utf8");
    expect(onDisk).toBe("# Hello World\n");
  });
});

// Shared setup for interactive tests (autoApprove:false — exercises the real emit→resolve chain).
function makeInteractiveConfig(repoPath: string) {
  return {
    model: "claude-sonnet-4-6",
    provider: "anthropic" as const,
    anthropicApiKey: "sk-ant-test",
    openaiApiKey: undefined,
    dailyUsdCap: 10,
    repoPath,
    forceTier: undefined,
    autoApprove: false,
    noRevision: false,
    verbose: false,
    quiet: true,
    noColor: true,
  };
}

function makePlanScript(mocks: { createChatCompletion: ReturnType<typeof vi.fn> }) {
  const planJson = JSON.stringify({
    objective: "Update greeting.md to say Hello World",
    steps: [{ title: "Update greeting.md", filesLikely: ["greeting.md"], subagentEligible: false }],
    riskHints: [],
    scopeSummary: "greeting.md",
  });
  installScript(mocks.createChatCompletion, [
    scriptText(`\`\`\`json\n${planJson}\n\`\`\``),
    scriptToolCall("write_file", { filePath: "greeting.md", content: "# Hello World\n" }),
  ]);
}

describe("R3 Stage 2b — composition: interactive path (autoApprove:false)", () => {
  // dispatch.ts line 501: `autoApprove: effectiveConfig.autoApprove || process.stdout.isTTY !== true`
  // In non-TTY (test) environments isTTY is undefined → auto-approves even with autoApprove:false.
  // Force isTTY=true so the interactive emit→resolve path is exercised, not the auto-approve shortcut.
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true, writable: true });
  });
  afterEach(() => {
    // Restore to undefined (non-TTY) — delete removes the overridden own property.
    try { delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY; } catch { /* no-op */ }
  });

  it("approve via onProgress: file flushed to disk (exercises real emit→mapper→resolve chain)", async () => {
    const targetFile = path.join(repoPath, "greeting.md");
    fs.writeFileSync(targetFile, "# Hello\n");
    makePlanScript(mocks);

    const result = await runOneShotInner(
      "update the greeting to say Hello World",
      makeInteractiveConfig(repoPath),
      "comp-run-interactive-1",
      {
        mode: "plan",
        externalAc: new AbortController(),
        onProgress: (update: LlmPatchProgressUpdate) => {
          if (typeof update === "object" && "progress" in update) {
            const p = update.progress as ZoneStructuredProgressEvent | undefined;
            if (p?.type === "staged_diffs_ready_for_approval" && p.approvalId) {
              resolveStagedApproval({ approvalId: p.approvalId, runId: p.runId ?? "", decision: "approve_all" });
            }
          }
        },
      }
    );

    expect(result).toBeDefined();
    expect(fs.readFileSync(targetFile, "utf8")).toBe("# Hello World\n");
  });

  it("reject via onProgress: file NOT flushed, original content preserved", async () => {
    const targetFile = path.join(repoPath, "greeting.md");
    fs.writeFileSync(targetFile, "# Hello\n");
    makePlanScript(mocks);

    const result = await runOneShotInner(
      "update the greeting to say Hello World",
      makeInteractiveConfig(repoPath),
      "comp-run-interactive-2",
      {
        mode: "plan",
        externalAc: new AbortController(),
        onProgress: (update: LlmPatchProgressUpdate) => {
          if (typeof update === "object" && "progress" in update) {
            const p = update.progress as ZoneStructuredProgressEvent | undefined;
            if (p?.type === "staged_diffs_ready_for_approval" && p.approvalId) {
              resolveStagedApproval({ approvalId: p.approvalId, runId: p.runId ?? "", decision: "reject" });
            }
          }
        },
      }
    );

    // staged_rejected → dispatch returns plan_rejected_by_user
    expect(result).toMatchObject({ ok: false });
    // No flush on reject — original content must be preserved.
    expect(fs.readFileSync(targetFile, "utf8")).toBe("# Hello\n");
  });
});
