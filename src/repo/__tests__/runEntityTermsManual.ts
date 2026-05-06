/**
 * Manual fixture test for extractEntityTerms.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/repo/__tests__/runEntityTermsManual.ts
 */
const { extractEntityTerms } = await import(
  "../../../dist/repo/rankRelevantFiles.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// 1. CamelCase
{
  const got: string[] = extractEntityTerms("call useUserAuth somewhere");
  check("CamelCase identifier extracted", got.includes("useuserauth"), got);
}

// 2. SCREAMING_SNAKE_CASE
{
  const got: string[] = extractEntityTerms("set DATABASE_URL in .env");
  check("SCREAMING_SNAKE extracted", got.includes("database_url"), got);
}

// 3. snake_case (length > 4 with underscore)
{
  const got: string[] = extractEntityTerms("user_session is invalid");
  check("snake_case extracted", got.includes("user_session"), got);
}

// 4. English stopwords filtered
{
  const got: string[] = extractEntityTerms("the function returns null");
  check("stopwords filtered (the/function/null)", got.length === 0, got);
}

// 5. Quoted identifier
{
  const got: string[] = extractEntityTerms("explain the `hasClerkEnv` helper");
  check("quoted identifier extracted", got.includes("hasclerkenv"), got);
}

// 6. Mixed: complex realistic task
{
  const got: string[] = extractEntityTerms(
    "What environment variables does this project use? Look at NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and getSupabaseUrl"
  );
  check(
    "mixed task: env var + camelCase function both extracted",
    got.includes("next_public_clerk_publishable_key") && got.includes("getsupabaseurl"),
    got
  );
}

// 7. Generic short words ignored
{
  const got: string[] = extractEntityTerms("use a const var");
  check("very short / generic words ignored", got.length === 0, got);
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[entity-terms-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
