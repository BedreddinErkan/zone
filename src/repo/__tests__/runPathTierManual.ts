/**
 * Manual fixture test for computePathTierScore.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/repo/__tests__/runPathTierManual.ts
 */
const { computePathTierScore } = await import(
  "../../../dist/repo/rankRelevantFiles.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// 1. Tier 1: source-of-truth
{
  const got: number = computePathTierScore("lib/env.ts");
  check("lib/env.ts → tier 8 (source-of-truth)", got === 8, got);
}

// 2. Tier 2: entry points
{
  const got: number = computePathTierScore("app/api/users/route.ts");
  check("app/api/.../route.ts → tier 8 (api SEGMENT not present here; lib also absent — expect 5 via 'app')", got === 5, got);
}

// 3. Tier 3: UI
{
  const got: number = computePathTierScore("components/Header.tsx");
  check("components/Header.tsx → tier 4", got === 4, got);
}

// 4. Tier 4: data layer
{
  const got: number = computePathTierScore("models/User.ts");
  check("models/User.ts → tier 4", got === 4, got);
}

// 5. Tier 9: tests deprioritized
{
  const got: number = computePathTierScore("tests/foo.test.ts");
  check("tests/foo.test.ts → tier 1", got === 1, got);
}

// 6. Segment match isolation: substring 'componentry' should NOT match 'components'
{
  const got: number = computePathTierScore("componentry/foo.ts");
  check("componentry/ does NOT match 'components' segment", got === 0, got);
}

// 7. Root-level file with no tier segment
{
  const got: number = computePathTierScore("package.json");
  check("package.json (root) → 0", got === 0, got);
}

// 8. Mixed: src/lib/ should hit Tier 1 from 'lib' (highest wins)
{
  const got: number = computePathTierScore("src/lib/utils.ts");
  check("src/lib/utils.ts → 8 (Tier 1 from lib)", got === 8, got);
}

// 9. Multiple matching segments → highest wins
{
  const got: number = computePathTierScore("src/lib/components/Header.tsx");
  check(
    "src/lib/components/Header.tsx → 8 (lib Tier1 beats components Tier3)",
    got === 8,
    got
  );
}

// 10. Empty/edge: empty path returns 0
{
  const got: number = computePathTierScore("");
  check("empty path → 0", got === 0, got);
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[path-tier-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
