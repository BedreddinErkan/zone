/**
 * Y.2.2 regression reproducer: fileDiffs must be non-empty even when
 * agentLoop returns filesModified:[] (the bug observed in production run
 * 4e034526). The defensive fallback in runLlmPatchFlow uses the beforeByFile
 * snapshot (populated in onToolCall before the filesModified.add site) to
 * recover diffs for any file that onToolCall saw but filesModified missed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AgentLoopInput, AgentLoopResult } from "../llm/agentLoop.js";

// ── mocks ────────────────────────────────────────────────────────────────────

const runAgentLoopMock = vi.fn<[AgentLoopInput], Promise<AgentLoopResult>>();

vi.mock("../llm/agentLoop.js", () => ({
  runAgentLoop: (...args: [AgentLoopInput]) => runAgentLoopMock(...args),
  stripVerificationTag: (s: string) => s,
}));

vi.mock("../repo/scanRepo.js", () => ({
  scanRepo: vi.fn(async (repoPath: string) => [
    {
      path: "src/target.ts",
      absolutePath: path.join(repoPath, "src/target.ts"),
      extension: "ts",
      category: "backend",
    },
  ]),
}));

vi.mock("../repo/detectProjectStructure.js", () => ({
  detectProjectStructure: vi.fn(() => ({ notes: ["TypeScript project"] })),
}));

vi.mock("../repo/rankRelevantFiles.js", () => ({
  rankRelevantFiles: vi.fn(({ files }: { files: unknown[] }) =>
    files.map((f, i) => ({ ...(f as object), score: 100 - i }))
  ),
}));

vi.mock("../repo/readProjectFiles.js", () => ({
  readProjectFiles: vi.fn(async (paths: string[]) =>
    Object.fromEntries(paths.map((p) => [p, "// original"]))
  ),
}));

vi.mock("../llm/planFeature.js", () => ({
  planFeatureWithLlm: vi.fn(async () => { throw new Error("skip"); }),
}));

vi.mock("../llm/planPatchPreview.js", () => ({
  planPatchPreviewWithLlm: vi.fn(async () => { throw new Error("skip"); }),
}));

vi.mock("../llm/planFullPatch.js", () => ({
  planFullPatchWithLlm: vi.fn(async () => { throw new Error("skip"); }),
}));

vi.mock("../llm/plannerStep.js", () => ({
  plannerStep: vi.fn(async () => { throw new Error("skip"); }),
}));

vi.mock("../llm/executionPlan.js", () => ({
  generateExecutionPlan: vi.fn(async () => { throw new Error("skip"); }),
}));

vi.mock("./runRuntimeVerification.js", () => ({
  runRuntimeVerificationPlan: vi.fn(async () => ({
    attempted: false,
    status: "skipped_no_command",
    steps: [],
    summary: "No safe verification command detected.",
  })),
}));

vi.mock("../llm/taskClassifier.js", () => ({
  classifyTask: vi.fn(async () => ({
    tier: "medium",
    confidence: 0,
    classifierModel: "claude-haiku-4-5",
    classifierCostUsd: 0,
    classifierLatencyMs: 1,
    fallbackUsed: true,
    fallbackReason: "mock",
  })),
}));

vi.mock("./planOrchestrator.js", () => ({
  isPlanOrchestrationEnabled: vi.fn(() => false),
  buildStepTask: vi.fn((task: string) => task),
  aggregateOrchestratorResults: vi.fn(),
}));

// ── helpers ───────────────────────────────────────────────────────────────────

const ORIGINAL = "export const x = 1;\n";
const PATCHED  = "export const x = 2; // patched\n";

let tmpDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zone-y22-repro-"));
  await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "src/target.ts"), ORIGINAL, "utf8");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe("Y.2.2 fileDiffs fallback", () => {
  it("recovers fileDiffs when agentLoop returns filesModified:[] but onToolCall fired", async () => {
    runAgentLoopMock.mockImplementation(async (loopInput: AgentLoopInput) => {
      // Simulate onToolCall firing (as agentLoop does before filesModified.add)
      loopInput.onToolCall?.("apply_patch", { filePath: "src/target.ts" });

      // Simulate the actual patch hitting the filesystem
      writeFileSync(path.join(tmpDir, "src/target.ts"), PATCHED, "utf8");

      // Bug: filesModified is empty despite the patch running
      return {
        success: true,
        summary: "Done",
        toolCallLog: [],
        filesModified: [],           // <-- the bug
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
        terminationReason: "natural_completion",
      } satisfies AgentLoopResult;
    });

    process.env["ZONE_FORCE_FLOW"] = "agent_loop";
    try {
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: "Bump x from 1 to 2 in src/target.ts",
        repoPath: tmpDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The defensive fallback must surface the diff even though filesModified was []
      expect(result.fileDiffs).toBeDefined();
      expect(result.fileDiffs!.length).toBeGreaterThan(0);

      const diff = result.fileDiffs![0]!;
      expect(diff.filePath).toBe("src/target.ts");
      expect(diff.addedLines).toBeGreaterThan(0);
    } finally {
      delete process.env["ZONE_FORCE_FLOW"];
    }
  });

  it("multi_edit: onToolCall snapshot + Part A filesModified → non-empty fileDiff with correct before/after", async () => {
    // Verifies Part A (filesModified includes multi_edit paths) AND Part B (beforeByFile snapshot
    // keyed with resolveAgentPath so it matches the fileDiffs lookup key). If the keys diverge,
    // beforeByFile.get(rel) returns undefined → before falls back to post-flush disk = PATCHED =
    // after → computeFileDiff gives 0 lines → this assertion fails, catching the key-mismatch bug.
    runAgentLoopMock.mockImplementation(async (loopInput: AgentLoopInput) => {
      // Part B: trigger the onToolCall multi_edit snapshot (captures ORIGINAL as "before")
      loopInput.onToolCall?.("multi_edit", { files: ["src/target.ts"], find: "x", replace: "y" });

      // Simulate finalizeStaging flushing the staged content to disk (PATCHED = "after")
      writeFileSync(path.join(tmpDir, "src/target.ts"), PATCHED, "utf8");

      // Part A: agentLoop now includes multi_edit paths in filesModified
      return {
        success: true,
        summary: "Done",
        toolCallLog: [],
        filesModified: ["src/target.ts"],
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
        terminationReason: "natural_completion",
      } satisfies AgentLoopResult;
    });

    process.env["ZONE_FORCE_FLOW"] = "agent_loop";
    try {
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: "Replace x with y in src/target.ts",
        repoPath: tmpDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.fileDiffs).toBeDefined();
      expect(result.fileDiffs!.length).toBeGreaterThan(0);

      const diff = result.fileDiffs![0]!;
      expect(diff.filePath).toBe("src/target.ts");
      // Non-empty diff proves beforeByFile key matched: before=ORIGINAL, after=PATCHED → real diff
      expect(diff.addedLines + diff.removedLines).toBeGreaterThan(0);
    } finally {
      delete process.env["ZONE_FORCE_FLOW"];
    }
  });

  it("produces empty fileDiffs when file content is unchanged (no false positives)", async () => {
    runAgentLoopMock.mockImplementation(async (loopInput: AgentLoopInput) => {
      loopInput.onToolCall?.("apply_patch", { filePath: "src/target.ts" });
      // No actual file write — content stays ORIGINAL
      return {
        success: true,
        summary: "Done",
        toolCallLog: [],
        filesModified: [],
        patchValidatedByAgent: false,
        verificationReason: "no_verification_attempted",
        terminationReason: "natural_completion",
      } satisfies AgentLoopResult;
    });

    process.env["ZONE_FORCE_FLOW"] = "agent_loop";
    try {
      const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
      const result = await runLlmPatchFlow({
        task: "Bump x from 1 to 2 in src/target.ts",
        repoPath: tmpDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // File unchanged → fallback must NOT produce a spurious diff entry
      const changed = (result.fileDiffs ?? []).filter((d) => d.addedLines > 0 || d.removedLines > 0);
      expect(changed).toHaveLength(0);
    } finally {
      delete process.env["ZONE_FORCE_FLOW"];
    }
  });
});
