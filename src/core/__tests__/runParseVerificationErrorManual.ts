/**
 * Manual fixture test for parseVerificationError (parser-fix Tur).
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/core/__tests__/runParseVerificationErrorManual.ts
 *
 * Pins the regex-alternation fix that prevents `.tsx` from being silently
 * truncated to `.ts` (and `.jsx` to `.js`). Covers all four regex sites in
 * parseVerificationError.ts: winRe, posixRe, atRe, fileReGlobal.
 *
 * Without the fix, the scope-expansion path adds `components/AppProviders.ts`
 * (wrong) instead of `components/AppProviders.tsx` (right), causing the next
 * apply_patch to be blocked by the scope guard.
 */
const { parseVerificationError } = await import(
  "../../../dist/core/parseVerificationError.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// 1. Scope-block message with .tsx in quotes (the exact form that broke last smoke)
{
  const r = parseVerificationError(
    `Write blocked: "components/AppProviders.tsx" is outside the planned scope.`,
    []
  );
  check(
    "scope-block message: .tsx survives extraction",
    r.failingFile === "components/AppProviders.tsx",
    r.failingFile
  );
}

// 2. TypeScript error with explicit .tsx path + line:col
{
  const r = parseVerificationError(
    `Type error in components/AppProviders.tsx:5:10. Cannot find name 'ClerkProvider'.`,
    []
  );
  const ok =
    r.failingFile === "components/AppProviders.tsx" &&
    r.affectedFiles.includes("components/AppProviders.tsx");
  check("ts error with .tsx + line:col → both fields preserve .tsx", ok, {
    failingFile: r.failingFile,
    affected: r.affectedFiles,
  });
}

// 3. Plain .ts files still extract correctly (no regression)
{
  const r = parseVerificationError(`Type error in lib/env.ts:12:3.`, []);
  check(
    ".ts files still parse correctly",
    r.failingFile === "lib/env.ts",
    r.failingFile
  );
}

// 4. .jsx survives (same alternation issue would have dropped the x)
{
  const r = parseVerificationError(`Error in components/Old.jsx:1:1.`, []);
  check(
    ".jsx survives extraction",
    r.failingFile === "components/Old.jsx",
    r.failingFile
  );
}

// 5. .js files still parse correctly (no regression on the shorter extension)
{
  const r = parseVerificationError(`Error in scripts/legacy.js:7:2.`, []);
  check(
    ".js files still parse correctly",
    r.failingFile === "scripts/legacy.js",
    r.failingFile
  );
}

// 6. Mixed extensions in same message
{
  const r = parseVerificationError(
    `Errors: app/page.tsx:1, lib/env.ts:5, components/Foo.jsx:2, scripts/legacy.js:9`,
    []
  );
  const a = r.affectedFiles;
  const ok =
    a.includes("app/page.tsx") &&
    a.includes("lib/env.ts") &&
    a.includes("components/Foo.jsx") &&
    a.includes("scripts/legacy.js");
  check("mixed extensions: each preserved exactly", ok, a);
}

// 7. Windows path with .tsx (winRe coverage)
{
  const r = parseVerificationError(
    `C:\\Users\\foo\\app\\page.tsx:5:10`,
    []
  );
  const ok = r.failingFile != null && r.failingFile.endsWith("page.tsx");
  check("windows path with .tsx → ends with page.tsx", ok, r.failingFile);
}

// 8. Stack-trace style "(file.tsx:line:col)" (atRe coverage)
{
  const r = parseVerificationError(
    `at Component (components/AppProviders.tsx:42:13)`,
    []
  );
  const ok = r.failingFile === "components/AppProviders.tsx" && r.failingLine === 42;
  check("stack-trace `(file.tsx:line:col)` parses .tsx + line", ok, {
    failingFile: r.failingFile,
    failingLine: r.failingLine,
  });
}

// 9. Bare path:line:col with .tsx (fileReGlobal coverage, posix branch)
{
  const r = parseVerificationError(`app/layout.tsx:1:5 — Type error`, []);
  check(
    "bare path:line:col with .tsx",
    r.failingFile === "app/layout.tsx" && r.failingLine === 1,
    { failingFile: r.failingFile, failingLine: r.failingLine }
  );
}

// 10. Bare windows path:line:col with .tsx (fileReGlobal coverage, win branch)
{
  const r = parseVerificationError(`C:\\zone\\app\\page.tsx:7:3 — error`, []);
  const ok = r.failingFile != null && r.failingFile.endsWith("page.tsx");
  check("bare windows path:line:col with .tsx", ok, r.failingFile);
}

// 11. Adjacent .ts and .tsx in same line — both should be extracted intact
{
  const r = parseVerificationError(
    `Errors in lib/env.ts:1 and components/Header.tsx:2`,
    []
  );
  const a = r.affectedFiles;
  const ok = a.includes("lib/env.ts") && a.includes("components/Header.tsx");
  // Critical: must NOT contain components/Header.ts (the truncated form).
  const noTruncation = !a.includes("components/Header.ts");
  check("adjacent .ts + .tsx: both intact, no truncation", ok && noTruncation, a);
}

// 12. Pre-existing assertion: parseVerificationError still classifies error types
{
  const r = parseVerificationError(`SyntaxError in app/page.tsx:1:1`, []);
  check(
    "errorType still classified after the fix",
    r.errorType === "syntax_error" && r.failingFile === "app/page.tsx",
    { errorType: r.errorType, failingFile: r.failingFile }
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[parse-verification-error-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
