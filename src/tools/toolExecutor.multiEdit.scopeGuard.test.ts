import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeTool } from "./toolExecutor.js";
import type { ExecutionPlan } from "../llm/executionPlan.js";

/**
 * multi_edit called checkPathBoundary but never checkWriteScope — a standing plan-scope bypass
 * that a POPULATED filesLikely did not close. Every write outside the planned scope succeeded as
 * long as it went through this tool rather than apply_patch or write_file. That is a wider hole
 * than the empty-filesLikely fail-open it sat next to, because the fail-open at least required
 * the plan to carry no files at all.
 *
 * These tests pin PARITY, not just the block: the scope decision must be identical across all
 * three write tools for the same inputs, including both archetype bypasses and the deliberately
 * preserved fail-open. A guard that blocked correctly but bypassed differently would be its own
 * defect — refactor and complex_multi_file legitimately write outside the plan, and multi_edit is
 * the tool they use most.
 */

let repoPath: string;

const IN_SCOPE = "src/in.ts";
const OUT_OF_SCOPE = "src/out.ts";
const SEED = "const target = 1;\n";

function planWith(filesLikely: string[]): ExecutionPlan {
  return {
    objective: "x",
    steps: [{ title: "s", description: "d", filesLikely }],
    riskHints: [],
    scopeSummary: "",
  } as ExecutionPlan;
}

/** Runs one write tool and reduces the result to its scope decision. */
async function scopeDecision(
  tool: "apply_patch" | "write_file" | "multi_edit",
  filePath: string,
  executionPlan: ExecutionPlan | null,
  archetype?: string
): Promise<"ALLOW" | "BLOCK"> {
  const args =
    tool === "multi_edit"
      ? { files: [filePath], find: "target", replace: "renamed" }
      : tool === "write_file"
        ? { filePath, content: "const renamed = 1;\n" }
        : { filePath, patch: `--- FIND ---\n${SEED}--- REPLACE ---\nconst renamed = 1;\n` };

  const result = await executeTool(tool, args, repoPath, undefined, {
    stagingFiles: new Map<string, string>(),
    executionPlan,
    archetype,
    filesReadThisRun: new Set([filePath]),
  });
  return String(result.error ?? "").includes("out_of_plan_scope") ? "BLOCK" : "ALLOW";
}

beforeEach(() => {
  repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "zone-multiedit-scope-"));
  fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, IN_SCOPE), SEED, "utf8");
  fs.writeFileSync(path.join(repoPath, OUT_OF_SCOPE), SEED, "utf8");
});

afterEach(() => {
  fs.rmSync(repoPath, { recursive: true, force: true });
});

describe("multi_edit — plan-scope guard", () => {
  it("blocks a file outside the plan's filesLikely, and stages nothing", async () => {
    const result = await executeTool(
      "multi_edit",
      { files: [OUT_OF_SCOPE], find: "target", replace: "renamed" },
      repoPath,
      undefined,
      { stagingFiles: new Map(), executionPlan: planWith([IN_SCOPE]), filesReadThisRun: new Set() }
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("multi_edit_blocked_out_of_plan_scope");
    expect(result.filesStaged).toEqual([]);
    // Blocked in the pre-flight pass, so the on-disk file is untouched.
    expect(fs.readFileSync(path.join(repoPath, OUT_OF_SCOPE), "utf8")).toBe(SEED);
  });

  it("blocks the whole batch when any one file is out of scope — no partial staging", async () => {
    // The all-or-nothing property the pre-flight boundary check already guaranteed. A scope block
    // discovered mid-loop would reintroduce exactly the ambiguous partial-staging state that
    // pre-flight exists to prevent.
    const staging = new Map<string, string>();
    const result = await executeTool(
      "multi_edit",
      { files: [IN_SCOPE, OUT_OF_SCOPE], find: "target", replace: "renamed" },
      repoPath,
      undefined,
      { stagingFiles: staging, executionPlan: planWith([IN_SCOPE]), filesReadThisRun: new Set() }
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("multi_edit_blocked_out_of_plan_scope");
    expect(result.filesStaged).toEqual([]);
    expect(staging.size, "the in-scope file must not be staged either").toBe(0);
  });

  it("allows a file inside the plan's filesLikely", async () => {
    const result = await executeTool(
      "multi_edit",
      { files: [IN_SCOPE], find: "target", replace: "renamed" },
      repoPath,
      undefined,
      { stagingFiles: new Map(), executionPlan: planWith([IN_SCOPE]), filesReadThisRun: new Set() }
    );
    expect(result.success).toBe(true);
  });
});

describe("multi_edit — scope parity with apply_patch and write_file", () => {
  // Every row asserts the three tools agree, rather than asserting multi_edit's answer alone.
  // Establishing the decision independently per tool is what makes this a parity test: if a
  // future change alters the bypass at one call site, this fails even though each tool's own
  // behaviour might still look self-consistent.
  const scenarios: Array<[string, string, () => ExecutionPlan | null, string | undefined]> = [
    ["in-scope, no archetype", IN_SCOPE, () => planWith([IN_SCOPE]), undefined],
    ["out-of-scope, no archetype", OUT_OF_SCOPE, () => planWith([IN_SCOPE]), undefined],
    ["out-of-scope, archetype=refactor", OUT_OF_SCOPE, () => planWith([IN_SCOPE]), "refactor"],
    ["out-of-scope, archetype=complex_multi_file", OUT_OF_SCOPE, () => planWith([IN_SCOPE]), "complex_multi_file"],
    ["out-of-scope, archetype=debug", OUT_OF_SCOPE, () => planWith([IN_SCOPE]), "debug"],
    ["empty filesLikely — fail-open preserved", OUT_OF_SCOPE, () => planWith([]), undefined],
    ["no plan at all", OUT_OF_SCOPE, () => null, undefined],
  ];

  for (const [label, filePath, makePlan, archetype] of scenarios) {
    it(`${label}: all three write tools agree`, async () => {
      const plan = makePlan();
      const viaApplyPatch = await scopeDecision("apply_patch", filePath, plan, archetype);
      const viaWriteFile = await scopeDecision("write_file", filePath, plan, archetype);
      const viaMultiEdit = await scopeDecision("multi_edit", filePath, plan, archetype);
      expect(
        { multi_edit: viaMultiEdit, write_file: viaWriteFile },
        `multi_edit must match apply_patch (${viaApplyPatch}) for: ${label}`
      ).toEqual({ multi_edit: viaApplyPatch, write_file: viaApplyPatch });
    });
  }

  it("refactor and complex_multi_file bypass, and the bypass is what makes them ALLOW", async () => {
    // Guards against the parity rows above passing for the wrong reason — if the archetype
    // bypass silently stopped working, those rows would still agree, all three at BLOCK.
    expect(await scopeDecision("multi_edit", OUT_OF_SCOPE, planWith([IN_SCOPE]), "refactor")).toBe("ALLOW");
    expect(await scopeDecision("multi_edit", OUT_OF_SCOPE, planWith([IN_SCOPE]), undefined)).toBe("BLOCK");
  });
});
