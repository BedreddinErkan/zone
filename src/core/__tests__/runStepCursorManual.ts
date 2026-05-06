/**
 * Manual fixture test for findMatchingStepIndex (Tur P1 plan-step cursor).
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/core/__tests__/runStepCursorManual.ts
 *
 * Verifies the file-match heuristic that drives plan_step_started /
 * plan_step_complete SSE events. Replaces the prior monotonic cursor.
 */
const { findMatchingStepIndex } = await import(
  "../../../dist/core/runLlmPatchFlow.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

const plan = {
  objective: "demo",
  steps: [
    { title: "Step 1", description: "constants", filesLikely: ["lib/constants.ts"] },
    { title: "Step 2", description: "env helper", filesLikely: ["lib/env.ts"] },
    { title: "Step 3", description: "page", filesLikely: ["app/page.tsx"] },
  ],
  riskHints: [],
  scopeSummary: "demo",
};

// 1. Direct match step 0
{
  const got: number | null = findMatchingStepIndex(plan, "lib/constants.ts");
  check("lib/constants.ts → step 0", got === 0, got);
}

// 2. Direct match step 1
{
  const got: number | null = findMatchingStepIndex(plan, "lib/env.ts");
  check("lib/env.ts → step 1", got === 1, got);
}

// 3. Direct match step 2
{
  const got: number | null = findMatchingStepIndex(plan, "app/page.tsx");
  check("app/page.tsx → step 2", got === 2, got);
}

// 4. No match → null (truthful silence, no false-step assignment)
{
  const got: number | null = findMatchingStepIndex(plan, "components/Header.tsx");
  check("unrelated path → null", got === null, got);
}

// 5. Empty path → null
{
  const got: number | null = findMatchingStepIndex(plan, "");
  check("empty path → null", got === null, got);
}

// 6. Whitespace-only path → null
{
  const got: number | null = findMatchingStepIndex(plan, "   ");
  check("whitespace path → null", got === null, got);
}

// 7. Plan with no steps → null
{
  const got: number | null = findMatchingStepIndex(
    { steps: [] } as never,
    "lib/env.ts"
  );
  check("empty plan → null", got === null, got);
}

// 8. Null plan → null
{
  const got: number | null = findMatchingStepIndex(null, "lib/env.ts");
  check("null plan → null", got === null, got);
}

// 9. Step with missing filesLikely → still searches remaining steps
{
  const sparsePlan = {
    steps: [
      { title: "Step A", description: "no files" }, // missing filesLikely
      { title: "Step B", description: "with files", filesLikely: ["lib/env.ts"] },
    ],
  };
  const got: number | null = findMatchingStepIndex(sparsePlan as never, "lib/env.ts");
  check("plan with sparse filesLikely still finds match", got === 1, got);
}

// 10. First-match-wins when two steps reference the same file
{
  const dupPlan = {
    steps: [
      { title: "Step 1", description: "x", filesLikely: ["lib/env.ts"] },
      { title: "Step 2", description: "y", filesLikely: ["lib/env.ts"] },
    ],
  };
  const got: number | null = findMatchingStepIndex(dupPlan as never, "lib/env.ts");
  check("duplicate filesLikely → first match wins", got === 0, got);
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[step-cursor-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
