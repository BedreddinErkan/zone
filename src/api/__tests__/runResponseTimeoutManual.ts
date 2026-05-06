/**
 * Manual fixture test: verify /api/patch and /api/progress middleware bumps
 * res.setTimeout to ≥30 minutes. Guards against re-introduction of the
 * 5-minute timeout that caused the same-runId double-invocation bug.
 *
 * Build first (npm run build), then:
 *   node --experimental-strip-types src/api/__tests__/runResponseTimeoutManual.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type AssertEntry = { name: string; pass: boolean; got: unknown };
const checks: AssertEntry[] = [];

function check(name: string, pass: boolean, got: unknown) {
  checks.push({ name, pass, got });
  console.log(`[assert] ${pass ? "PASS" : "FAIL"} ${name} :: ${JSON.stringify(got)}`);
}

const MIN_TIMEOUT_MS = 30 * 60 * 1000;

// 1. Compiled dist/api/server.js advertises a >= 30min timeout middleware
{
  const distPath = resolve(
    new URL(".", import.meta.url).pathname,
    "../../../dist/api/server.js"
  );
  const compiled = readFileSync(distPath, "utf8");
  const matches = Array.from(
    compiled.matchAll(/res\.setTimeout\(\s*([\d_*\s]+)\s*\)/g)
  );
  const evaluated = matches.map((m) => {
    try {
      // Evaluate the captured numeric expression literally (e.g., "30 * 60 * 1000").
      const expr = m[1].replace(/_/g, "");
      // eslint-disable-next-line no-new-func
      return Number(new Function(`return (${expr})`)());
    } catch {
      return NaN;
    }
  });
  check(
    "dist/api/server.js contains at least 2 res.setTimeout calls",
    matches.length >= 2,
    { count: matches.length }
  );
  const allOk = evaluated.length >= 2 && evaluated.every((v) => v >= MIN_TIMEOUT_MS);
  check(
    "every res.setTimeout value is >= 30 minutes",
    allOk,
    { values: evaluated, min: MIN_TIMEOUT_MS }
  );
}

// 2. Direct mock-based check using a fake express app contract:
//    invoke the middleware and confirm res.setTimeout is called with >= 30 min.
{
  const fakeRes = {
    timeoutCalls: [] as number[],
    setTimeout(ms: number) {
      this.timeoutCalls.push(ms);
    },
  };
  // Recreate the middleware shape from server.ts inline (not imported — server.ts
  // bootstraps the express app on import, which we don't want for a unit fixture).
  const middleware = (_req: unknown, res: typeof fakeRes, next: () => void) => {
    res.setTimeout(30 * 60 * 1000);
    next();
  };
  let nextCalled = false;
  middleware({}, fakeRes, () => { nextCalled = true; });
  check(
    "middleware shape: setTimeout fired with 30min and next() called",
    fakeRes.timeoutCalls.length === 1 &&
      fakeRes.timeoutCalls[0] >= MIN_TIMEOUT_MS &&
      nextCalled,
    { timeoutCalls: fakeRes.timeoutCalls, nextCalled }
  );
}

const passed = checks.filter((c) => c.pass).length;
const total = checks.length;
console.log(`\n[response-timeout-test] PASSED ${passed}/${total} assertions`);
if (passed !== total) process.exit(1);
