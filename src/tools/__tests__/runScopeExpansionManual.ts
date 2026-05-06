/**
 * Manual fixture test for scope-expansion Tur.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/tools/__tests__/runScopeExpansionManual.ts
 *
 * Covers `maybeExpandScopeForVerifyDiagnostic` and its integration with
 * `checkWriteScope`: after expansion, the previously-blocked file becomes
 * writable; non-pinned files remain blocked.
 */
const { maybeExpandScopeForVerifyDiagnostic, checkWriteScope } = await import(
  "../../../dist/tools/scopeGuard.js"
);
const { buildVerifyDiagnostic } = await import(
  "../../../dist/core/buildVerifyDiagnostic.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

const makePlan = () => ({
  objective: "demo",
  steps: [
    { title: "step 1", description: "", filesLikely: ["lib/env.ts"] },
    { title: "step 2", description: "", filesLikely: ["lib/utils.ts"] },
  ],
  riskHints: [],
  scopeSummary: "demo",
});

const userFileDiag = buildVerifyDiagnostic({
  failedToolOutput: "Type error in app/layout.tsx:1\n",
  filesModified: [],
  filesInRepo: ["app/layout.tsx"],
  attemptCount: 1,
});

const generatedDiag = buildVerifyDiagnostic({
  failedToolOutput: "Error at .next/server/app/_global-error/page.js:42:13\n",
  filesModified: [],
  filesInRepo: [],
  attemptCount: 1,
});

const noFailingFileDiag = buildVerifyDiagnostic({
  failedToolOutput: "wall of text without any path",
  filesModified: [],
  filesInRepo: [],
  attemptCount: 1,
});

// 1. No plan → no_plan
{
  const got = maybeExpandScopeForVerifyDiagnostic(null, userFileDiag);
  check(
    "no plan → expanded:false reason:no_plan",
    got.expanded === false && got.reason === "no_plan",
    got
  );
}

// 2. Diagnostic without parsed failingFile → no_parsed_failing_file
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, noFailingFileDiag);
  check(
    "no parsed failing file → reason:no_parsed_failing_file",
    got.expanded === false && got.reason === "no_parsed_failing_file",
    got
  );
}

// 3. Generated path detected → generated_path
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, generatedDiag);
  check(
    "generated path → reason:generated_path",
    got.expanded === false && got.reason === "generated_path",
    got
  );
  // Plan must remain untouched
  const planFiles = plan.steps.flatMap((s) => s.filesLikely);
  check(
    "generated path → plan untouched",
    planFiles.length === 2 && !planFiles.some((f) => f.includes(".next")),
    planFiles
  );
}

// 4. File already in scope → already_in_scope
{
  const plan = makePlan();
  const diag = buildVerifyDiagnostic({
    failedToolOutput: "Type error in lib/env.ts:1\n",
    filesModified: [],
    filesInRepo: ["lib/env.ts"],
    attemptCount: 1,
  });
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, diag);
  check(
    "file already in scope → reason:already_in_scope",
    got.expanded === false && got.reason === "already_in_scope",
    got
  );
}

// 5. Hard-evidence user file outside scope → expanded:true + plan mutated
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, userFileDiag);
  const ok =
    got.expanded === true &&
    got.addedFile === "app/layout.tsx" &&
    typeof got.reason === "string" &&
    got.reason.startsWith("verify_diagnostic_failing_file:") &&
    plan.steps[0].filesLikely.includes("app/layout.tsx");
  check("user file outside scope → expanded + plan mutated", ok, {
    result: got,
    step0Files: plan.steps[0].filesLikely,
  });
}

// 6. After expansion, checkWriteScope accepts writes to the previously-blocked file
{
  const plan = makePlan();
  // Pre-expansion: blocked
  const pre = checkWriteScope("app/layout.tsx", plan as never);
  // Expand
  maybeExpandScopeForVerifyDiagnostic(plan as never, userFileDiag);
  // Post-expansion: allowed
  const post = checkWriteScope("app/layout.tsx", plan as never);
  check(
    "checkWriteScope: blocked before expansion, allowed after",
    typeof pre === "string" && pre.includes("Write blocked") && post === null,
    { pre, post }
  );
}

// 7. Two different failing files → two expansions, both in plan
{
  const plan = makePlan();
  const diagA = buildVerifyDiagnostic({
    failedToolOutput: "Type error in app/page.tsx:1\n",
    filesModified: [],
    filesInRepo: ["app/page.tsx"],
    attemptCount: 1,
  });
  const diagB = buildVerifyDiagnostic({
    failedToolOutput: "Type error in components/Header.tsx:1\n",
    filesModified: [],
    filesInRepo: ["components/Header.tsx"],
    attemptCount: 2,
  });
  const a = maybeExpandScopeForVerifyDiagnostic(plan as never, diagA);
  const b = maybeExpandScopeForVerifyDiagnostic(plan as never, diagB);
  const allFiles = plan.steps.flatMap((s) => s.filesLikely);
  const ok =
    a.expanded === true &&
    b.expanded === true &&
    allFiles.includes("app/page.tsx") &&
    allFiles.includes("components/Header.tsx");
  check("two failing files → two expansions, both present", ok, {
    a: a.addedFile,
    b: b.addedFile,
    allFiles,
  });
}

// 8. Same file twice → second is no-op
{
  const plan = makePlan();
  const a = maybeExpandScopeForVerifyDiagnostic(plan as never, userFileDiag);
  const b = maybeExpandScopeForVerifyDiagnostic(plan as never, userFileDiag);
  const occurrences = plan.steps[0].filesLikely.filter(
    (f) => f === "app/layout.tsx"
  ).length;
  const ok =
    a.expanded === true &&
    b.expanded === false &&
    b.reason === "already_in_scope" &&
    occurrences === 1;
  check("same file twice → second already_in_scope, no duplicate", ok, {
    first: a,
    second: b,
    occurrences,
  });
}

// 9. Path normalization: ./, /, \ all collapse
{
  const plan = makePlan();
  // Manually set parsed.failingFile shapes by constructing diagnostics
  // from outputs that contain different path styles.
  const dotPrefix = buildVerifyDiagnostic({
    failedToolOutput: "Type error in ./app/layout.tsx:1\n",
    filesModified: [],
    filesInRepo: [],
    attemptCount: 1,
  });
  const a = maybeExpandScopeForVerifyDiagnostic(plan as never, dotPrefix);
  // Now try the same file with no prefix — should be already_in_scope.
  const noPrefix = buildVerifyDiagnostic({
    failedToolOutput: "Type error in app/layout.tsx:1\n",
    filesModified: [],
    filesInRepo: [],
    attemptCount: 2,
  });
  const b = maybeExpandScopeForVerifyDiagnostic(plan as never, noPrefix);
  check(
    "path normalization: ./prefix and bare collapse to same scope entry",
    a.expanded === true &&
      a.addedFile === "app/layout.tsx" &&
      b.expanded === false &&
      b.reason === "already_in_scope",
    { a, b }
  );
}

// 10. Expansion does NOT relax for invented files (the agent picking a random "improvement")
{
  const plan = makePlan();
  // Expand for app/layout.tsx via diagnostic
  maybeExpandScopeForVerifyDiagnostic(plan as never, userFileDiag);
  // The agent now writes to a different, invented file with no diagnostic backing
  const blocked = checkWriteScope("app/random_new_file.tsx", plan as never);
  check(
    "invented file still blocked after expansion (only the pinned file is allowed)",
    typeof blocked === "string" && blocked.includes("Write blocked"),
    blocked
  );
}

// 11. Plan with no steps → reason:no_plan (since steps.length === 0 routes to that gate)
{
  const empty = {
    objective: "x",
    steps: [],
    riskHints: [],
    scopeSummary: "",
  };
  const got = maybeExpandScopeForVerifyDiagnostic(empty as never, userFileDiag);
  check(
    "empty steps → expanded:false (no_plan gate)",
    got.expanded === false && got.reason === "no_plan",
    got
  );
}

// ── scope-guard-path-bug Tur: repoPath-aware normalization ────────────────
// The normalizePath helper used to strip leading "/" unconditionally, so an
// absolute path like /home/user/repo/app/foo.tsx leaked into the scope set as
// "home/user/repo/app/foo.tsx" — a relative-looking string that misled the
// agent. The fix accepts an optional repoPath; absolute paths inside the repo
// collapse to their relative form, and absolute paths outside the repo are
// rejected via the OUT_OF_REPO_MARKER → "outside_repo" reason.

const REPO = "/home/user/repo";

// Helper: build a diagnostic with an arbitrary failingFile (bypassing the
// parser, since we want to drive the path-shape directly).
const fakeDiag = (failingFile: string): never => ({
  text: "diag",
  parsed: { failingFile, errorType: "type_error" },
  generatedPathDetected: false,
} as unknown as never);

// 12. absolute path with repoPath prefix → relative
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, fakeDiag("/home/user/repo/app/foo.tsx"), REPO);
  check(
    "absolute path with repoPath prefix → addedFile relative",
    got.expanded === true && got.addedFile === "app/foo.tsx",
    got
  );
}

// 13. absolute path outside repoPath → reason:outside_repo
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, fakeDiag("/etc/passwd"), REPO);
  check(
    "absolute path outside repoPath → reason:outside_repo",
    got.expanded === false && got.reason === "outside_repo",
    got
  );
}

// 14. relative path still works (regression check)
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, fakeDiag("app/foo.tsx"), REPO);
  check(
    "relative path with repoPath provided → unchanged behavior",
    got.expanded === true && got.addedFile === "app/foo.tsx",
    got
  );
}

// 15. ./relative path strips ./
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, fakeDiag("./components/Bar.tsx"), REPO);
  check(
    "./relative path strips ./",
    got.expanded === true && got.addedFile === "components/Bar.tsx",
    got
  );
}

// 16. absolute path equal to repoPath → empty after normalize
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, fakeDiag("/home/user/repo"), REPO);
  check(
    "absolute path equal to repoPath → empty_after_normalize",
    got.expanded === false && got.reason === "empty_after_normalize",
    got
  );
}

// 17. trailing slash on repoPath
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(plan as never, fakeDiag("/home/user/repo/app/foo.tsx"), "/home/user/repo/");
  check(
    "absolute path with trailing-slashed repoPath → addedFile relative",
    got.expanded === true && got.addedFile === "app/foo.tsx",
    got
  );
}

// 18. checkWriteScope rejects out-of-repo absolute path with repoPath provided
{
  const plan = makePlan();
  // Expand so plan has user-source entries
  maybeExpandScopeForVerifyDiagnostic(plan as never, fakeDiag("app/page.tsx"), REPO);
  const blocked = checkWriteScope("/etc/passwd", plan as never, REPO);
  check(
    "checkWriteScope: absolute out-of-repo path is rejected with explanation",
    typeof blocked === "string" && blocked.includes("outside the repo"),
    blocked
  );
}

// 19. The exact smoke-bug repro
{
  const plan = makePlan();
  const got = maybeExpandScopeForVerifyDiagnostic(
    plan as never,
    fakeDiag("/home/bedo/zone-landing/app/global-error.tsx"),
    "/home/bedo/zone-landing"
  );
  check(
    "smoke-bug repro: scope expansion produces clean relative path (no home/bedo prefix leak)",
    got.expanded === true &&
      got.addedFile === "app/global-error.tsx" &&
      !String(got.addedFile).includes("home/bedo"),
    got
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[scope-expansion-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
