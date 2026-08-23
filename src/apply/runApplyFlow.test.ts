import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runApplyFlow } from "./runApplyFlow.js";
import type { PatchPlan } from "./patchPlan.js";
import type { RunAgentMode, RunAgentResult } from "../core/runAgent.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zone-apply-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

function buildRunAgentResult(mode: RunAgentMode): RunAgentResult {
  return {
    task: "rename helper function",
    decision: {
      mode,
      confidenceScore: 82
    },
    risk: {
      score: 18,
      breakdown: {
        destructive: 0,
        schema: 0,
        critical: 0,
        lowRisk: 10,
        massScope: 0
      }
    },
    confidence: {
      score: 82,
      breakdown: {
        base: 100,
        destructivePenalty: 0,
        schemaPenalty: 0,
        criticalPenalty: 0,
        massScopePenalty: 0,
        lowRiskBonus: 0
      }
    },
    explanation: "SAFE TO APPLY: Task appears localized and low risk.",
    recommendation: "Safe to apply with standard review.",
    topRisks: [],
    trace: {} as RunAgentResult["trace"],
    reasonCodes: []
  };
}

describe("runApplyFlow", () => {
  it("does not apply when decision mode is blocked", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "example.ts");

    const plan: PatchPlan = {
      patches: [
        {
          filePath,
          nextContent: "export const value = 1;\n"
        }
      ]
    };

    const result = await runApplyFlow({
      result: buildRunAgentResult("blocked"),
      plan,
      request: { confirm: true },
      repoPath: dir
    });

    expect(result).toEqual({
      applied: false,
      filesChanged: [],
      summary: "Blocked decisions cannot be applied."
    });
  });

  it("does not apply when confirmation is missing", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "example.ts");

    const plan: PatchPlan = {
      patches: [
        {
          filePath,
          nextContent: "export const value = 1;\n"
        }
      ]
    };

    const result = await runApplyFlow({
      result: buildRunAgentResult("safe_to_apply"),
      plan,
      request: { confirm: false },
      repoPath: dir
    });

    expect(result).toEqual({
      applied: false,
      filesChanged: [],
      summary: "Apply confirmation is required."
    });
  });

  it("applies a valid patch plan for safe_to_apply mode", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "example.ts");

    const plan: PatchPlan = {
      patches: [
        {
          filePath,
          nextContent: "export const value = 42;\n"
        }
      ]
    };

    const result = await runApplyFlow({
      result: buildRunAgentResult("safe_to_apply"),
      plan,
      request: { confirm: true },
      repoPath: dir
    });

    const saved = await fs.readFile(filePath, "utf8");

    expect(saved).toBe("export const value = 42;\n");
    expect(result).toEqual({
      applied: true,
      filesChanged: [filePath],
      summary: "Applied 1 file change(s)."
    });
  });

  it("throws for an empty patch plan", async () => {
    await expect(
      runApplyFlow({
        result: buildRunAgentResult("safe_to_apply"),
        plan: { patches: [] },
        request: { confirm: true },
        repoPath: process.cwd()
      })
    ).rejects.toThrow("Patch plan must include at least one patch.");
  });

  it("throws for duplicate file paths", async () => {
    const dir = await createTempDir();
    const filePath = path.join(dir, "example.ts");

    await expect(
      runApplyFlow({
        result: buildRunAgentResult("safe_to_apply"),
        plan: {
          patches: [
            {
              filePath,
              nextContent: "export const value = 1;\n"
            },
            {
              filePath,
              nextContent: "export const value = 2;\n"
            }
          ]
        },
        request: { confirm: true },
        repoPath: dir
      })
    ).rejects.toThrow(`Duplicate patch filePath detected: ${filePath}`);
  });
});
