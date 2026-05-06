/**
 * Manual fixture test for extractMentionedFiles.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/repo/__tests__/runMentionExtractionManual.ts
 */
const { extractMentionedFiles } = await import(
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

// 1. Full path with extension
{
  const got: Set<string> = extractMentionedFiles("Read lib/env.ts and tell me about it", [
    f("lib/env.ts"),
    f("lib/utils.ts"),
  ]);
  check("full path lib/env.ts → only lib/env.ts", got.size === 1 && got.has("lib/env.ts"), [...got]);
}

// 2. Multiple paths
{
  const got: Set<string> = extractMentionedFiles(
    "edit src/foo.tsx and src/bar.tsx",
    [f("src/foo.tsx"), f("src/bar.tsx")]
  );
  check(
    "multiple file mentions",
    got.size === 2 && got.has("src/foo.tsx") && got.has("src/bar.tsx"),
    [...got]
  );
}

// 3. Bare basename with extension
{
  const got: Set<string> = extractMentionedFiles("the env.ts file please", [f("lib/env.ts"), f("lib/utils.ts")]);
  check("bare env.ts → lib/env.ts (unambiguous)", got.size === 1 && got.has("lib/env.ts"), [...got]);
}

// 4. CamelCase bareword
{
  const got: Set<string> = extractMentionedFiles(
    "AppProviders component should be updated",
    [f("components/AppProviders.tsx"), f("components/Header.tsx")]
  );
  check(
    "CamelCase bareword AppProviders → components/AppProviders.tsx",
    got.size === 1 && got.has("components/AppProviders.tsx"),
    [...got]
  );
}

// 5. Ambiguous basename: 2 files named index.ts → both returned
{
  const got: Set<string> = extractMentionedFiles("update the index.ts file", [
    f("src/index.ts"),
    f("lib/index.ts"),
  ]);
  check(
    "ambiguous basename → all candidates included",
    got.size === 2 && got.has("src/index.ts") && got.has("lib/index.ts"),
    [...got]
  );
}

// 6. Generic English word: no false positives
{
  const got: Set<string> = extractMentionedFiles(
    "what is the config like for this project",
    [f("lib/env.ts"), f("package.json")]
  );
  check("generic word 'config' → no false positives", got.size === 0, [...got]);
}

// 7. Path-like token but file doesn't exist
{
  const got: Set<string> = extractMentionedFiles("look at fake/file.ts please", [f("lib/env.ts")]);
  check("nonexistent path token → empty", got.size === 0, [...got]);
}

// 8. Empty task
{
  const got: Set<string> = extractMentionedFiles("", [f("lib/env.ts")]);
  check("empty task → empty set", got.size === 0, [...got]);
}

// 9. Disambiguation via path-fragment in task
{
  const got: Set<string> = extractMentionedFiles(
    "look at src/index.ts only, not the other one",
    [f("src/index.ts"), f("lib/index.ts")]
  );
  check(
    "ambiguous basename + full path mentioned → that path wins",
    got.size === 1 && got.has("src/index.ts"),
    [...got]
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[mention-extraction-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
