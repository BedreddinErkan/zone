/**
 * Manual test for verdict-to-UI coherence and tests_passed validation.
 *
 * Run after building dist:
 *   node --experimental-strip-types src/llm/__tests__/runVerdictUiCoherenceManual.ts
 */
import fs from "node:fs";

const modulePath =
  process.env.ZONE_AGENT_LOOP_MODULE || "../../../dist/llm/agentLoop.js";
const { validatePassedClaim } = await import(modulePath);

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

const checks = [];

{
  const result = validatePassedClaim([
    {
      tool: "run_command",
      args: { command: "npm test" },
      result: "Tests: 12 passed, 0 failed",
      success: true,
    },
  ]);
  checks.push(check("accepts tests passed summary", result.accept === true, result));
}

{
  const result = validatePassedClaim([
    {
      tool: "run_command",
      args: { command: "pytest" },
      result: "===== 12 passed in 0.5s =====",
      success: true,
    },
  ]);
  checks.push(check("accepts pytest-style output", result.accept === true, result));
}

{
  const result = validatePassedClaim([
    {
      tool: "run_command",
      args: { command: "npx vitest run" },
      result: "✓ 5 tests passed",
      success: true,
    },
  ]);
  checks.push(check("accepts vitest tick output", result.accept === true, result));
}

{
  const result = validatePassedClaim([]);
  checks.push(check(
    "demotes tests_passed when no run_command exists",
    result.accept === false && result.demoteTo === "no_verification_attempted",
    result
  ));
}

{
  const result = validatePassedClaim([
    {
      tool: "run_command",
      args: { command: "npm test" },
      result: "Command failed with exit code 1",
      success: false,
    },
  ]);
  checks.push(check(
    "demotes tests_passed when run_command failed",
    result.accept === false && result.demoteTo === "tests_inconclusive",
    result
  ));
}

{
  const result = validatePassedClaim([
    {
      tool: "run_command",
      args: { command: "npm run build" },
      result: "Build complete in 3s",
      success: true,
    },
  ]);
  checks.push(check(
    "demotes tests_passed when no pass pattern appears",
    result.accept === false && result.demoteTo === "tests_inconclusive",
    result
  ));
}

{
  const uiSource = fs.readFileSync("src/ui/index.html", "utf8");
  checks.push(check(
    "UI maps skipped and unverified verdict labels",
    uiSource.includes("tests_skipped_no_infra") &&
      uiSource.includes("Tests skipped") &&
      uiSource.includes("no_verification_attempted") &&
      uiSource.includes("Not verified"),
    {}
  ));
}

{
  const coreSource = fs.readFileSync("src/core/runLlmPatchFlow.ts", "utf8");
  const skippedIndex = coreSource.indexOf('vr === "tests_skipped_no_infra"');
  const skippedBlock = skippedIndex >= 0 ? coreSource.slice(skippedIndex, skippedIndex + 260) : "";
  checks.push(check(
    "core keeps skipped-no-infra safe_to_apply note",
    skippedBlock.includes('agentDecisionMode = "safe_to_apply"') &&
      skippedBlock.includes("Tests skipped (no test infrastructure found)"),
    { skippedBlock }
  ));
}

const failed = checks.filter((c) => !c.pass);
console.log(
  `[verdict-ui-coherence-test] PASSED ${checks.length - failed.length}/${checks.length} assertions`
);
if (failed.length > 0) {
  process.exitCode = 1;
}
