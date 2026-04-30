import { validateUnrelatedClaim } from "../../../dist/llm/agentLoop.js";

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
        success: false,
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
        success: false,
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
          "FAIL src/foo.test.ts\n  x should work\n  AssertionError: expected 1 to equal 2\n  at src/foo.test.ts:42",
        success: false,
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
          "FAIL src/legacy.test.ts\n  x old test\n  AssertionError\n  at src/legacy.test.ts:10",
        success: false,
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
        success: false,
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
        success: true,
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(
    check(
      "no run_command demotes to tests_inconclusive",
      result.accept === false &&
        result.demoteTo === "tests_inconclusive" &&
        String(result.reason || "").includes("no run_command in log"),
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
        result: "PASS all good",
        success: true,
      },
      {
        tool: "run_command",
        args: {},
        result: "FAIL src/foo.test.ts AssertionError at src/foo.test.ts:5",
        success: false,
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

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: {},
        result: "All tests passed!\n5 passed, 0 failed",
        success: true,
      },
      {
        tool: "apply_patch",
        args: {},
        result: "ok",
        success: true,
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(
    check(
      "run_command without failure-looking output is accepted",
      result.accept === true &&
        String(result.reason || "").includes("run_command(s) executed but none look like failure"),
      result
    )
  );
}

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: { command: "npx playwright test" },
        result:
          "Command failed: npx playwright test\nnpm warn Unknown env config \"\". This will stop working in the next major version of npm.\n",
        success: false,
      },
      {
        tool: "apply_patch",
        args: { filePath: "src/foo.ts" },
        result: "ok",
        success: true,
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(
    check(
      "success false metadata without failing file demotes to tests_inconclusive",
      result.accept === false &&
        result.demoteTo === "tests_inconclusive" &&
        String(result.reason || "").includes("no failing file extracted"),
      result
    )
  );
}

{
  const result = validateUnrelatedClaim({
    log: [
      {
        tool: "run_command",
        args: { command: "npm test" },
        result: "Tests: 5 passed, 0 failed\n",
        success: true,
      },
    ],
    patchedFilePaths: ["src/foo.ts"],
  });
  checks.push(
    check(
      "success true metadata with pass-like text is accepted",
      result.accept === true &&
        String(result.reason || "").includes("none look like failure"),
      result
    )
  );
}

const passedCount = checks.filter((entry) => entry.pass).length;
console.log(`\n[verification-verdict-test] PASSED ${passedCount}/10 assertions`);

if (passedCount !== 10) {
  process.exitCode = 1;
}
