/**
 * Manual fixture test for Tur P2.1 plan-orchestrator skeleton helpers.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/core/__tests__/runOrchestratorSkeletonManual.ts
 *
 * Covers the pure helpers in dist/core/planOrchestrator.js:
 *   - isPlanOrchestrationEnabled (flag + plan-shape gating)
 *   - buildStepTask (per-step task framing)
 *   - aggregateOrchestratorResults (composite shape downstream needs)
 *
 * Does NOT exercise the live orchestrator loop — that requires the full patch
 * flow and is covered by smoke. This file pins the contracts those helpers
 * promise so a future refactor can't silently change them.
 */
const { isPlanOrchestrationEnabled, buildStepTask, aggregateOrchestratorResults } =
  await import("../../../dist/core/planOrchestrator.js");

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

const planTwoSteps = {
  objective: "demo",
  steps: [
    { title: "Step 1", description: "create constants", filesLikely: ["lib/constants.ts"] },
    { title: "Step 2", description: "add helper", filesLikely: ["lib/env.ts"] },
  ],
  riskHints: [],
  scopeSummary: "demo",
};

const planOneStep = {
  objective: "demo",
  steps: [
    { title: "Only step", description: "single file", filesLikely: ["lib/env.ts"] },
  ],
  riskHints: [],
  scopeSummary: "demo",
};

// ── isPlanOrchestrationEnabled ────────────────────────────────────────────

// 1. Flag off, multi-step plan → false
{
  const got = isPlanOrchestrationEnabled(planTwoSteps as never, undefined);
  check("flag undefined → false", got === false, got);
}
{
  const got = isPlanOrchestrationEnabled(planTwoSteps as never, "");
  check("flag empty → false", got === false, got);
}
{
  const got = isPlanOrchestrationEnabled(planTwoSteps as never, "0");
  check("flag '0' → false", got === false, got);
}
{
  const got = isPlanOrchestrationEnabled(planTwoSteps as never, "false");
  check("flag 'false' → false", got === false, got);
}

// 2. Flag on but null/empty plan → false
{
  const got = isPlanOrchestrationEnabled(null, "1");
  check("flag '1' but null plan → false", got === false, got);
}
{
  const got = isPlanOrchestrationEnabled(undefined, "1");
  check("flag '1' but undefined plan → false", got === false, got);
}
{
  const got = isPlanOrchestrationEnabled(
    { objective: "x", steps: [], riskHints: [], scopeSummary: "" } as never,
    "1"
  );
  check("flag '1' but 0-step plan → false", got === false, got);
}

// 3. Flag on, single-step plan → false (no value in orchestrating one step)
{
  const got = isPlanOrchestrationEnabled(planOneStep as never, "1");
  check("flag '1' but 1-step plan → false", got === false, got);
}

// 4. Flag on, multi-step plan → true (both '1' and 'true', case-insensitive)
{
  const got = isPlanOrchestrationEnabled(planTwoSteps as never, "1");
  check("flag '1' + multi-step → true", got === true, got);
}
{
  const got = isPlanOrchestrationEnabled(planTwoSteps as never, "true");
  check("flag 'true' + multi-step → true", got === true, got);
}
{
  const got = isPlanOrchestrationEnabled(planTwoSteps as never, "TRUE");
  check("flag 'TRUE' (case insensitive) → true", got === true, got);
}
{
  const got = isPlanOrchestrationEnabled(planTwoSteps as never, "  1  ");
  check("flag '  1  ' (trimmed) → true", got === true, got);
}

// ── buildStepTask ─────────────────────────────────────────────────────────

// 5. Includes original task + step title + filesLikely
{
  const got: string = buildStepTask("Do all three things.", 0, planTwoSteps as never);
  const ok =
    got.includes("Do all three things.") &&
    got.includes("Step 1") &&
    got.includes("CURRENT STEP (1 of 2)") &&
    got.includes("lib/constants.ts") &&
    got.includes("create constants");
  check("buildStepTask step 0 includes all framing", ok, got.slice(0, 200));
}

// 6. Step 2 framing (1-indexed in prose, 0-indexed in code)
{
  const got: string = buildStepTask("Original.", 1, planTwoSteps as never);
  const ok =
    got.includes("CURRENT STEP (2 of 2)") &&
    got.includes("Step 2") &&
    got.includes("lib/env.ts");
  check("buildStepTask step 1 → '(2 of 2)' framing", ok, got.slice(0, 200));
}

// 7. Out-of-bounds idx → returns original task as fallback
{
  const got: string = buildStepTask("Original.", 99, planTwoSteps as never);
  check("buildStepTask out-of-bounds → original task", got === "Original.", got);
}

// 8. Step with empty filesLikely → still produces a task (no Files line)
{
  const planNoFiles = {
    objective: "x",
    steps: [{ title: "T", description: "D", filesLikely: [] }],
    riskHints: [],
    scopeSummary: "",
  };
  const got: string = buildStepTask("Orig.", 0, planNoFiles as never);
  const ok = got.includes("CURRENT STEP (1 of 1)") && !got.includes("Files for this step:");
  check("buildStepTask: empty filesLikely → no Files line", ok, got);
}

// ── aggregateOrchestratorResults ──────────────────────────────────────────

// 9. Empty list → benign success result
{
  const got = aggregateOrchestratorResults([]);
  const ok =
    got.success === true &&
    got.summary === "" &&
    Array.isArray(got.toolCallLog) &&
    got.toolCallLog.length === 0 &&
    Array.isArray(got.filesModified) &&
    got.filesModified.length === 0 &&
    !got.error;
  check("aggregate empty → benign success", ok, got);
}

// 10. All-success aggregate
{
  const a = {
    success: true,
    summary: "did A",
    toolCallLog: [{ tool: "write_file", args: {}, result: "ok" }],
    filesModified: ["lib/a.ts"],
    patchValidatedByAgent: true,
    verificationReason: "tests_passed" as const,
  };
  const b = {
    success: true,
    summary: "did B",
    toolCallLog: [{ tool: "apply_patch", args: {}, result: "ok" }],
    filesModified: ["lib/b.ts"],
    patchValidatedByAgent: true,
    verificationReason: "tests_passed" as const,
  };
  const got = aggregateOrchestratorResults([a, b]);
  const ok =
    got.success === true &&
    got.filesModified.length === 2 &&
    got.toolCallLog.length === 2 &&
    got.summary.includes("[step 1]") &&
    got.summary.includes("[step 2]") &&
    !got.error &&
    got.patchValidatedByAgent === true;
  check("aggregate all-success: union files, concat log, labelled summary", ok, {
    success: got.success,
    files: got.filesModified,
    toolLogLen: got.toolCallLog.length,
    summarySnippet: got.summary.slice(0, 80),
    error: got.error ?? null,
    validated: got.patchValidatedByAgent,
  });
}

// 11. Mixed success/failure: success=false, error string includes step number
{
  const a = {
    success: true,
    summary: "did A",
    toolCallLog: [],
    filesModified: ["x.ts"],
    patchValidatedByAgent: true,
    verificationReason: "tests_passed" as const,
  };
  const b = {
    success: false,
    summary: "broken",
    toolCallLog: [],
    filesModified: [],
    error: "patch failed",
    patchValidatedByAgent: false,
    verificationReason: "tests_failed_by_patch" as const,
  };
  const got = aggregateOrchestratorResults([a, b]);
  const ok =
    got.success === false &&
    typeof got.error === "string" &&
    got.error.includes("step 2") &&
    got.error.includes("patch failed") &&
    got.patchValidatedByAgent === false;
  check("aggregate with one failure: success false, error labelled", ok, {
    success: got.success,
    error: got.error,
    validated: got.patchValidatedByAgent,
  });
}

// 12. Staged files dedup across steps
{
  const a = {
    success: true,
    summary: "",
    toolCallLog: [],
    filesModified: ["lib/shared.ts", "lib/a.ts"],
    patchValidatedByAgent: true,
    verificationReason: "tests_passed" as const,
  };
  const b = {
    success: true,
    summary: "",
    toolCallLog: [],
    filesModified: ["lib/shared.ts", "lib/b.ts"],
    patchValidatedByAgent: true,
    verificationReason: "tests_passed" as const,
  };
  const got = aggregateOrchestratorResults([a, b]);
  const sortedFiles = [...got.filesModified].sort();
  const ok =
    got.filesModified.length === 3 &&
    sortedFiles[0] === "lib/a.ts" &&
    sortedFiles[1] === "lib/b.ts" &&
    sortedFiles[2] === "lib/shared.ts";
  check("aggregate dedups filesModified across steps", ok, got.filesModified);
}

// 13. verificationReason: last step's value wins
{
  const a = {
    success: true,
    summary: "",
    toolCallLog: [],
    filesModified: [],
    patchValidatedByAgent: true,
    verificationReason: "tests_passed" as const,
  };
  const b = {
    success: true,
    summary: "",
    toolCallLog: [],
    filesModified: [],
    patchValidatedByAgent: true,
    verificationReason: "tests_skipped_no_infra" as const,
  };
  const got = aggregateOrchestratorResults([a, b]);
  check("aggregate verificationReason → last step", got.verificationReason === "tests_skipped_no_infra", got.verificationReason);
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[orchestrator-skeleton-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
