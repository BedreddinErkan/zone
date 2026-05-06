/**
 * Manual fixture test for expandWithDomainTerms.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/repo/__tests__/runDomainMapManual.ts
 */
const { expandWithDomainTerms, extractEntityTerms } = await import(
  "../../../dist/repo/rankRelevantFiles.js"
);

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];
function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

// 1. env vars
{
  const got: string[] = expandWithDomainTerms(
    "What environment variables does this project use?",
    []
  );
  check(
    "env phrase → env, process.env, readenv",
    got.includes("env") && got.includes("process.env") && got.includes("readenv"),
    got
  );
}

// 2. authentication
{
  const got: string[] = expandWithDomainTerms("Show me the authentication flow", []);
  check(
    "authentication → clerk, auth0, login, session, jwt",
    got.includes("clerk") &&
      got.includes("auth0") &&
      got.includes("login") &&
      got.includes("session") &&
      got.includes("jwt"),
    got
  );
}

// 3. database
{
  const got: string[] = expandWithDomainTerms("Where's the database schema?", []);
  check(
    "database → prisma, drizzle, schema, model (via 'database' AND 'schema' phrases)",
    got.includes("prisma") && got.includes("drizzle") && got.includes("schema") && got.includes("model"),
    got
  );
}

// 4. API endpoints
{
  const got: string[] = expandWithDomainTerms("List the API endpoints", []);
  check(
    "endpoint → route, endpoint, handler, controller",
    got.includes("route") && got.includes("endpoint") && got.includes("handler") && got.includes("controller"),
    got
  );
}

// 5. payments
{
  const got: string[] = expandWithDomainTerms("How does payment work?", []);
  check(
    "payment → stripe, payment, checkout, subscription",
    got.includes("stripe") && got.includes("payment") && got.includes("checkout") && got.includes("subscription"),
    got
  );
}

// 6. form validation
{
  const got: string[] = expandWithDomainTerms("Find the form validation logic", []);
  check(
    "form → zod, yup, form, validation",
    got.includes("zod") && got.includes("yup") && got.includes("form") && got.includes("validation"),
    got
  );
}

// 7. tests
{
  const got: string[] = expandWithDomainTerms("Where are the tests?", []);
  check(
    "test → test, spec, fixture",
    got.includes("test") && got.includes("spec") && got.includes("fixture"),
    got
  );
}

// 8. No domain phrase → returns just baseTerms
{
  const got: string[] = expandWithDomainTerms("Add a new button to the header", ["button", "header"]);
  check(
    "no domain phrase → baseTerms preserved, no expansion",
    got.includes("button") && got.includes("header") && got.length === 2,
    got
  );
}

// 9. Both 'auth' AND 'authentication' present → terms not duplicated (Set dedup)
{
  const got: string[] = expandWithDomainTerms(
    "auth and authentication should both be considered",
    []
  );
  const counts: Record<string, number> = {};
  for (const t of got) counts[t] = (counts[t] ?? 0) + 1;
  const dups = Object.entries(counts).filter(([_, c]) => c > 1);
  check("auth + authentication → no duplicates", dups.length === 0, { dups, sample: got.slice(0, 6) });
}

// 10. Quoted entity term + domain expansion both flow through
{
  const taskText = `Show how "useUserAuth" handles authentication`;
  const baseTerms: string[] = extractEntityTerms(taskText);
  const expanded: string[] = expandWithDomainTerms(taskText, baseTerms);
  check(
    "quoted identifier preserved alongside domain expansion",
    expanded.includes("useuserauth") &&
      expanded.includes("clerk") &&
      expanded.includes("auth0"),
    { baseTerms, expanded }
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[domain-map-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
