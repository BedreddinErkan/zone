import { buildCoachingPrompt } from "../../../dist/llm/agentLoop.js";
import { ZONE_TOOLS } from "../../../dist/tools/toolDefinitions.js";

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

console.log("\n=== scope discipline ===");

{
  const text = buildCoachingPrompt("apply_patch_scope_not_found", "sample error", []);
  const lower = text.toLowerCase();

  checks.push(check(
    "scope_not_found prompt teaches scope discipline",
    lower.includes("arrow-function") &&
      text.includes("__default__") &&
      text.includes("REMOVE the scope parameter"),
    { preview: text.slice(0, 260) }
  ));
}

{
  const text = buildCoachingPrompt("test_failed", "sample error", []);
  const lower = text.toLowerCase();
  checks.push(check(
    "test_failed prompt does not mention scope-discipline internals",
    !lower.includes("arrow-function") && !text.includes("__default__"),
    { preview: text.slice(0, 220) }
  ));
}

{
  const applyPatchTool = ZONE_TOOLS.find(
    (tool) => "name" in tool && tool.name === "apply_patch"
  );
  const scopeDescription =
    applyPatchTool &&
    "parameters" in applyPatchTool &&
    applyPatchTool.parameters &&
    typeof applyPatchTool.parameters === "object" &&
    "properties" in applyPatchTool.parameters &&
    applyPatchTool.parameters.properties &&
    typeof applyPatchTool.parameters.properties === "object" &&
    "scope" in applyPatchTool.parameters.properties &&
    applyPatchTool.parameters.properties.scope &&
    typeof applyPatchTool.parameters.properties.scope === "object" &&
    "description" in applyPatchTool.parameters.properties.scope
      ? String(applyPatchTool.parameters.properties.scope.description ?? "")
      : "";
  const lower = scopeDescription.toLowerCase();

  checks.push(check(
    "apply_patch scope schema warns about unsupported targets",
    lower.includes("arrow-function") &&
      (lower.includes("default export") || scopeDescription.includes("__default__")) &&
      (lower.includes("omit") || lower.includes("do not use")),
    { descriptionPreview: scopeDescription.slice(0, 320) }
  ));
}

const passedCount = checks.filter((entry) => entry.pass).length;
console.log(`\n[scope-discipline-test] PASSED ${passedCount}/3 assertions`);

if (passedCount !== 3) {
  process.exitCode = 1;
}
