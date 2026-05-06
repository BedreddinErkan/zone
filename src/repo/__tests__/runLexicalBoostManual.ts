/**
 * Manual fixture test for the lexical content-scan boost in rankRelevantFiles.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/repo/__tests__/runLexicalBoostManual.ts
 */
const { rankRelevantFiles } = await import(
  "../../../dist/repo/rankRelevantFiles.js"
);

type RepoFile = { path: string; absolutePath: string; extension: string; category: string };
function f(p: string): RepoFile {
  const ext = p.includes(".") ? (p.split(".").pop() ?? "") : "";
  return { path: p, absolutePath: `/repo/${p}`, extension: ext, category: "unknown" };
}

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// 1. Identifier in 1 file → that file boosted relative to baseline
{
  const files = [f("src/foo.ts"), f("src/bar.ts")];
  const contents: Record<string, string> = {
    "src/foo.ts": "export function hasClerkEnv() { return true; }",
    "src/bar.ts": "export const noise = 1;",
  };
  const noLexical = await rankRelevantFiles({ task: "explain hasClerkEnv helper", files });
  const withLexical = await rankRelevantFiles({
    task: "explain hasClerkEnv helper",
    files,
    readContent: async (p: string) => contents[p] ?? null,
  });
  const fooNo = noLexical.find((x: { path: string; score: number }) => x.path === "src/foo.ts")?.score ?? 0;
  const fooLex = withLexical.find((x: { path: string; score: number }) => x.path === "src/foo.ts")?.score ?? 0;
  check(
    "identifier in 1 file → boost ≥ 5 vs no-lexical baseline",
    fooLex - fooNo >= 5,
    { fooNo, fooLex }
  );
}

// 2. Identifier in multiple files → both boosted
{
  const files = [f("src/a.ts"), f("src/b.ts")];
  const contents: Record<string, string> = {
    "src/a.ts": "export const renderUserProfile = () => {};",
    "src/b.ts": "import { renderUserProfile } from './a';",
  };
  const ranked = await rankRelevantFiles({
    task: "explain renderUserProfile function",
    files,
    readContent: async (p: string) => contents[p] ?? null,
  });
  const a = ranked.find((x: { path: string; score: number }) => x.path === "src/a.ts")?.score ?? 0;
  const b = ranked.find((x: { path: string; score: number }) => x.path === "src/b.ts")?.score ?? 0;
  check("identifier in multiple files → both boosted", a >= 5 && b >= 5, { a, b });
}

// 3. No matching identifier → no score change vs no-lexical
{
  const files = [f("src/foo.ts")];
  const contents: Record<string, string> = { "src/foo.ts": "export const x = 1;" };
  const noLex = await rankRelevantFiles({ task: "tell me about getDatabaseConnection", files });
  const withLex = await rankRelevantFiles({
    task: "tell me about getDatabaseConnection",
    files,
    readContent: async (p: string) => contents[p] ?? null,
  });
  const a1 = noLex[0]?.score ?? 0;
  const a2 = withLex[0]?.score ?? 0;
  check("no matching identifier → no boost", a1 === a2, { a1, a2 });
}

// 4. Stopword task → no entity terms → no boost
{
  const files = [f("src/foo.ts")];
  const contents: Record<string, string> = {
    "src/foo.ts": "// the function returns null when value is undefined",
  };
  const noLex = await rankRelevantFiles({ task: "the function returns", files });
  const withLex = await rankRelevantFiles({
    task: "the function returns",
    files,
    readContent: async (p: string) => contents[p] ?? null,
  });
  check(
    "stopword-only task → no boost (entity terms empty)",
    (noLex[0]?.score ?? 0) === (withLex[0]?.score ?? 0),
    { noLex: noLex[0]?.score, withLex: withLex[0]?.score }
  );
}

// 5. Boost capped at +50 even with many hits
{
  const files = [f("src/foo.ts")];
  // Pack many hits of an identifier into the file body — we expect the boost to cap at +50.
  const repeated = "renderUserProfile ".repeat(200);
  const contents: Record<string, string> = { "src/foo.ts": repeated };
  const noLex = await rankRelevantFiles({ task: "renderUserProfile function logic", files });
  const withLex = await rankRelevantFiles({
    task: "renderUserProfile function logic",
    files,
    readContent: async (p: string) => contents[p] ?? null,
  });
  const delta = (withLex[0]?.score ?? 0) - (noLex[0]?.score ?? 0);
  check("boost capped at +50", delta <= 50, { delta });
}

// 6. File-read error → silent skip, no crash
{
  const files = [f("src/foo.ts"), f("src/bar.ts")];
  const ranked = await rankRelevantFiles({
    task: "explain renderUserProfile",
    files,
    readContent: async () => {
      throw new Error("read failed");
    },
  });
  check("read errors → silent skip, no crash, files still returned", ranked.length === 2, {
    n: ranked.length,
  });
}

// 7. Domain expansion: query uses domain language, file content uses identifier
//    "authentication" expands to include "clerk", which the file references.
{
  const files = [f("lib/foo.ts"), f("lib/bar.ts")];
  const contents: Record<string, string> = {
    "lib/foo.ts": "import { clerkClient } from '@clerk/nextjs/server';",
    "lib/bar.ts": "export const noise = 1;",
  };
  const noLex = await rankRelevantFiles({ task: "explain authentication", files });
  const withLex = await rankRelevantFiles({
    task: "explain authentication",
    files,
    readContent: async (p: string) => contents[p] ?? null,
  });
  const fooNo = noLex.find((x: { path: string; score: number }) => x.path === "lib/foo.ts")?.score ?? 0;
  const fooLex = withLex.find((x: { path: string; score: number }) => x.path === "lib/foo.ts")?.score ?? 0;
  check(
    "domain phrase 'authentication' → expands to include clerk → boosts foo.ts",
    fooLex - fooNo >= 5,
    { fooNo, fooLex }
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[lexical-boost-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
