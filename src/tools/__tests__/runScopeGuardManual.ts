/**
 * Manual fixture test for checkWriteScope (Tur P2-scope plan-based guard).
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/tools/__tests__/runScopeGuardManual.ts
 *
 * Verifies that the write-scope guard returns null (allow) when there is no
 * plan / no filesLikely info / a matching path, and returns an actionable
 * error string when the file is outside the plan's filesLikely union.
 */
const { checkWriteScope } = await import(
  "../../../dist/tools/scopeGuard.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

const planTwoFiles = {
  objective: "demo",
  steps: [
    { title: "Step 1", description: "constants", filesLikely: ["lib/env.ts"] },
    { title: "Step 2", description: "utils", filesLikely: ["lib/utils.ts"] },
  ],
  riskHints: [],
  scopeSummary: "demo",
};

// 1. null plan → allow
{
  const got: string | null = checkWriteScope("any/file.ts", null);
  check("null plan → null", got === null, got);
}

// 2. undefined plan → allow
{
  const got: string | null = checkWriteScope("any/file.ts", undefined);
  check("undefined plan → null", got === null, got);
}

// 3. Plan with empty steps → allow
{
  const got: string | null = checkWriteScope(
    "lib/env.ts",
    { objective: "x", steps: [], riskHints: [], scopeSummary: "" } as never
  );
  check("empty steps → null", got === null, got);
}

// 4. Plan steps but every filesLikely is empty → allow (graceful fallback)
{
  const sparsePlan = {
    objective: "x",
    steps: [
      { title: "a", description: "", filesLikely: [] },
      { title: "b", description: "" }, // missing filesLikely entirely
    ],
    riskHints: [],
    scopeSummary: "",
  };
  const got: string | null = checkWriteScope("lib/env.ts", sparsePlan as never);
  check("empty filesLikely on all steps → null", got === null, got);
}

// 5. filePath in filesLikely → allow
{
  const got: string | null = checkWriteScope("lib/env.ts", planTwoFiles);
  check("path in filesLikely → null", got === null, got);
}

// 6. filePath NOT in filesLikely → block + error mentions plan scope
{
  const got: string | null = checkWriteScope(
    "components/AppProviders.tsx",
    planTwoFiles
  );
  const hasError = typeof got === "string" && got.length > 0;
  const mentionsScope = hasError && got.includes("lib/env.ts") && got.includes("lib/utils.ts");
  const mentionsTarget = hasError && got.includes("AppProviders.tsx");
  check("out-of-scope path → error string", hasError, got);
  check("error mentions plan scope", mentionsScope, got);
  check("error mentions blocked target path", mentionsTarget, got);
}

// 7. Path normalization: leading "./"
{
  const got: string | null = checkWriteScope("./lib/env.ts", planTwoFiles);
  check("./prefix matches lib/env.ts → null", got === null, got);
}

// 8. Path normalization: Windows backslashes
{
  const got: string | null = checkWriteScope("lib\\env.ts", planTwoFiles);
  check("backslashes match forward slashes → null", got === null, got);
}

// 9. Path normalization on the plan side too (filesLikely with ./)
{
  const planDotPrefix = {
    objective: "x",
    steps: [{ title: "s", description: "", filesLikely: ["./lib/env.ts"] }],
    riskHints: [],
    scopeSummary: "",
  };
  const got: string | null = checkWriteScope("lib/env.ts", planDotPrefix as never);
  check("plan filesLikely with ./ matches plain path → null", got === null, got);
}

// 10. Multi-step union: file in step 2's filesLikely passes
{
  const got: string | null = checkWriteScope("lib/utils.ts", planTwoFiles);
  check("path in step 2 filesLikely → null (union)", got === null, got);
}

// 11. Single step plan with single file — out-of-scope blocked
{
  const oneStepPlan = {
    objective: "x",
    steps: [{ title: "s", description: "", filesLikely: ["lib/env.ts"] }],
    riskHints: [],
    scopeSummary: "",
  };
  const got: string | null = checkWriteScope(
    "components/Header.tsx",
    oneStepPlan as never
  );
  check("single-step plan, out-of-scope → error", typeof got === "string" && got.length > 0, got);
}

// 12. Truncation hint when union has more than 5 paths
{
  const bigPlan = {
    objective: "x",
    steps: [
      {
        title: "s",
        description: "",
        filesLikely: [
          "a/1.ts",
          "a/2.ts",
          "a/3.ts",
          "a/4.ts",
          "a/5.ts",
          "a/6.ts",
          "a/7.ts",
        ],
      },
    ],
    riskHints: [],
    scopeSummary: "",
  };
  const got: string | null = checkWriteScope("z/other.ts", bigPlan as never);
  const truncated = typeof got === "string" && got.includes("(and 2 more)");
  check("more than 5 plan paths → 'and N more' suffix", truncated, got);
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[scope-guard-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
