/**
 * Manual fixture test for agent-persistence Tur diagnostic injection.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/core/__tests__/runVerifyDiagnosticManual.ts
 *
 * Covers:
 *   - detectGeneratedPath (.next/, dist/, build/, out/, .svelte-kit/, .nuxt/)
 *   - buildVerifyDiagnostic shape: parsed-null vs parsed-with-signal,
 *     generated-path detection, candidate-culprit selection.
 *   - buildCoachingPrompt(test_failed) variant gating: hard-investigate
 *     when generatedPathDetected=true, classifier path when false.
 *   - Other coaching triggers untouched.
 */
const { detectGeneratedPath, buildVerifyDiagnostic } = await import(
  "../../../dist/core/buildVerifyDiagnostic.js"
);
const { buildCoachingPrompt } = await import(
  "../../../dist/llm/agentLoop.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// ── detectGeneratedPath ───────────────────────────────────────────────────

check("detect: .next/server/app/foo → true", detectGeneratedPath(".next/server/app/foo.js") === true, true);
check("detect: dist/index.js → true", detectGeneratedPath("dist/index.js") === true, true);
check("detect: build/static/x.js → true", detectGeneratedPath("build/static/x.js") === true, true);
check("detect: out/index.html → true", detectGeneratedPath("out/index.html") === true, true);
check("detect: .svelte-kit/output → true", detectGeneratedPath(".svelte-kit/output/foo.js") === true, true);
check("detect: .nuxt/dist → true", detectGeneratedPath(".nuxt/dist/foo.js") === true, true);

check("detect: app/page.tsx → false", detectGeneratedPath("app/page.tsx") === false, false);
check("detect: components/Header.tsx → false", detectGeneratedPath("components/Header.tsx") === false, false);
check("detect: node_modules/x → false (not a generated path)", detectGeneratedPath("node_modules/foo/index.js") === false, false);
check("detect: null → false", detectGeneratedPath(null) === false, false);
check("detect: empty → false", detectGeneratedPath("") === false, false);

// Normalization
check("detect: ./.next/server → true (./ stripped)", detectGeneratedPath("./.next/server/foo.js") === true, true);
check("detect: .next\\server (windows) → true", detectGeneratedPath(".next\\server\\foo.js") === true, true);
check("detect: /.next/server → true (leading / stripped)", detectGeneratedPath("/.next/server/foo.js") === true, true);

// Conservative — must NOT flag arbitrary 'generated' dirs or partial matches
check("detect: src/build/foo.ts → false (build/ as dir prefix only)", detectGeneratedPath("src/build/foo.ts") === false, false);
check("detect: prebuild/foo → false (no prefix match)", detectGeneratedPath("prebuild/foo.js") === false, false);

// ── buildVerifyDiagnostic ─────────────────────────────────────────────────

// 1. Raw output without recognizable error → parsed: null, no warning
{
  const out = buildVerifyDiagnostic({
    failedToolOutput: "some unrecognizable wall of text",
    filesModified: [],
    filesInRepo: [],
    attemptCount: 1,
  });
  const ok =
    out.parsed === null &&
    out.generatedPathDetected === false &&
    out.candidates.length === 0 &&
    out.text.includes("not extractable");
  check("diag: no parser hit → null parsed + 'not extractable'", ok, {
    parsed: out.parsed,
    generated: out.generatedPathDetected,
    candidates: out.candidates.length,
    snippet: out.text.slice(0, 100),
  });
}

// 2. Parser extracts user file → no generated-path warning, no candidates
{
  const out = buildVerifyDiagnostic({
    failedToolOutput: "Error: foo at app/page.tsx:42:10\n",
    filesModified: ["app/page.tsx"],
    filesInRepo: ["app/page.tsx", "app/layout.tsx", "components/Header.tsx"],
    attemptCount: 1,
  });
  const ok =
    out.parsed?.failingFile === "app/page.tsx" &&
    out.generatedPathDetected === false &&
    out.candidates.length === 0 &&
    !out.text.includes("Generated-path indicator");
  check("diag: user-file failure → no generated-path warning", ok, {
    failing: out.parsed?.failingFile,
    generated: out.generatedPathDetected,
    candidatesLen: out.candidates.length,
  });
}

// 3. Parser extracts .next/ path → generated-path detected, warning + candidates
{
  const out = buildVerifyDiagnostic({
    failedToolOutput:
      "TypeError: Cannot read properties of null (reading 'useContext')\n" +
      "    at .next/server/app/_global-error/page.js:42:13\n",
    filesModified: [],
    filesInRepo: [
      "app/layout.tsx",
      "app/page.tsx",
      "components/AppProviders.tsx",
      "components/Header.tsx",
      "lib/env.ts",
      "node_modules/next/dist/client/foo.js", // must be skipped
    ],
    attemptCount: 1,
  });
  const ok =
    out.generatedPathDetected === true &&
    out.text.includes("Generated-path indicator") &&
    out.text.includes("use client") &&
    out.candidates.includes("app/layout.tsx") &&
    out.candidates.includes("components/AppProviders.tsx") &&
    !out.candidates.some((c) => c.startsWith("node_modules/"));
  check("diag: .next/ failure → generated detected + layout+provider candidates", ok, {
    generated: out.generatedPathDetected,
    candidates: out.candidates,
  });
}

// 4. filesModified appear FIRST in candidates when generated-path detected
{
  const out = buildVerifyDiagnostic({
    failedToolOutput: "Error in .next/server/app/_global-error/page.js:1:1",
    filesModified: ["lib/recently-touched.ts"],
    filesInRepo: ["app/layout.tsx", "lib/recently-touched.ts", "components/FooProvider.tsx"],
    attemptCount: 1,
  });
  const ok =
    out.candidates[0] === "lib/recently-touched.ts" &&
    out.candidates.includes("app/layout.tsx") &&
    out.candidates.includes("components/FooProvider.tsx");
  check("diag: filesModified come first in candidates", ok, out.candidates);
}

// 5. Empty filesInRepo + generated path → candidates equal filesModified (fallback)
{
  const out = buildVerifyDiagnostic({
    failedToolOutput: "TypeError in .next/server/foo.js:1:1",
    filesModified: ["lib/x.ts"],
    filesInRepo: [],
    attemptCount: 2,
  });
  const ok =
    out.generatedPathDetected === true &&
    out.candidates.length === 1 &&
    out.candidates[0] === "lib/x.ts";
  check("diag: empty filesInRepo + generated → candidates from filesModified", ok, out.candidates);
}

// 6. attemptCount appears in header
{
  const out = buildVerifyDiagnostic({
    failedToolOutput: "x",
    filesModified: [],
    filesInRepo: [],
    attemptCount: 3,
  });
  check("diag: attemptCount in header", out.text.includes("attempt 3"), out.text.split("\n")[0]);
}

// 7. filesModified listed in tail when present
{
  const out = buildVerifyDiagnostic({
    failedToolOutput: "x",
    filesModified: ["lib/a.ts", "lib/b.ts"],
    filesInRepo: [],
    attemptCount: 1,
  });
  check(
    "diag: filesModified in tail",
    out.text.includes("Files you modified this run") && out.text.includes("lib/a.ts"),
    out.text
  );
}

// ── buildCoachingPrompt: test_failed gating ───────────────────────────────

// 8. generatedPathDetected=true → mandatory-investigation text + ban on unrelated
{
  const text: string = buildCoachingPrompt("test_failed", "x", [], {
    attemptCount: 1,
    generatedPathDetected: true,
    parsedFailingFile: ".next/server/app/_global-error/page.js",
  });
  const ok =
    text.includes("MANDATORY investigation") &&
    text.includes("MUST NOT emit [ZONE_VERIFICATION: tests_failed_unrelated]") &&
    text.includes(".next/server/app/_global-error/page.js") &&
    text.includes("use client");
  check("coaching: generated-path → mandatory investigate variant", ok, text.slice(0, 200));
}

// 9. generatedPathDetected=false (or omitted) → original classifier text
{
  const text: string = buildCoachingPrompt("test_failed", "x", [], { attemptCount: 1 });
  const ok =
    text.includes("Tests reported failure or warnings") &&
    text.includes("tests_failed_unrelated") &&
    !text.includes("MANDATORY investigation");
  check("coaching: non-generated-path → classifier variant unchanged", ok, text.slice(0, 200));
}

// 10. Other triggers unaffected by the new options
{
  const text: string = buildCoachingPrompt("apply_patch_find_not_found", "x", [], {
    attemptCount: 1,
    generatedPathDetected: true, // should be ignored for non-test_failed
  });
  const ok = text.includes("FIND block") && !text.includes("MANDATORY investigation");
  check("coaching: apply_patch_find_not_found ignores generatedPathDetected", ok, text.slice(0, 120));
}

// 11. parsedFailingFile null + generated-path → fallback wording
{
  const text: string = buildCoachingPrompt("test_failed", "x", [], {
    attemptCount: 1,
    generatedPathDetected: true,
    parsedFailingFile: null,
  });
  const ok =
    text.includes("MANDATORY investigation") &&
    text.includes("framework-generated path shown in the diagnostic above");
  check("coaching: generated-path + null failing file → fallback ref", ok, text.slice(0, 200));
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[verify-diagnostic-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
