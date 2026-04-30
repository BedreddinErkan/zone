import { validateUnrelatedClaim } from "../.tmp-build/llm/agentLoop.js";

function check(
  label: string,
  pass: boolean,
  details?: Record<string, unknown>
): { label: string; pass: boolean; details?: Record<string, unknown> } {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

const checks: Array<{ label: string; pass: boolean; details?: Record<string, unknown> }> = [];

console.log("\n=== verification verdict ===");

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: {},
        result: "npm WARN deprecated foo@1.0.0\nexit code 1",
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(check("tooling failure (npm warning) accepted", result.accept === true, result));
}

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: {},
        result: "spawn npm ENOENT",
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(check("ENOENT spawn error accepted", result.accept === true, result));
}

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: {},
        result:
          "FAIL src/foo.test.ts\n  ✗ should work\n  AssertionError: expected 1 to equal 2\n  at src/foo.test.ts:42",
      },
    ],
    patchedFilePaths: ["src/foo.test.ts"],
  });
  checks.push(
    check(
      "patched failing file demotes to tests_failed_by_patch",
      result.accept === false && result.demoteTo === "tests_failed_by_patch",
      result
    )
  );
}

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: {},
        result:
          "FAIL src/legacy.test.ts\n  ✗ old test\n  AssertionError\n  at src/legacy.test.ts:10",
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(
    check(
      "non-patched failing file with clear assertion is accepted",
      result.accept === true,
      result
    )
  );
}

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: {},
        result: "Tests failed.\nexit code 1",
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(
    check(
      "vague failure demotes to tests_inconclusive",
      result.accept === false && result.demoteTo === "tests_inconclusive",
      result
    )
  );
}

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "apply_patch",
        args: {},
        result: "ok",
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(check("no failing run_command passes through", result.accept === true, result));
}

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: {},
        result: "PASS all good",
      },
      {
        tool: "run_command",
        args: {},
        result: "FAIL src/foo.test.ts AssertionError at src/foo.test.ts:5",
      },
    ],
    patchedFilePaths: ["src/foo.test.ts"],
  });
  checks.push(
    check(
      "last failing run_command wins",
      result.accept === false && result.demoteTo === "tests_failed_by_patch",
      result
    )
  );
}

const passedCount = checks.filter((entry) => entry.pass).length;
console.log(`\n[verification-verdict-test] PASSED ${passedCount}/7 assertions`);

if (passedCount !== 7) {
  process.exitCode = 1;
}
