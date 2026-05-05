/**
 * Manual test for repeated apply_patch failure detection.
 *
 * Run after building dist, or point ZONE_AGENT_LOOP_MODULE at a compiled copy:
 *   node --experimental-strip-types src/llm/__tests__/runRepeatedFailureManual.ts
 */
const modulePath =
  process.env.ZONE_AGENT_LOOP_MODULE || "../../../dist/llm/agentLoop.js";
const {
  buildCoachingPrompt,
  classifyFailure,
  detectRepeatedFailure,
  hashPatchBlocks,
} = await import(modulePath);

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

function patch(find, replace) {
  return `--- FIND ---\n${find}\n--- REPLACE ---\n${replace}`;
}

function record(trigger, errorLine, patchText, iter) {
  return {
    trigger,
    errorLine,
    patchHash: hashPatchBlocks({ patch: patchText }),
    iter,
  };
}

const checks = [];

{
  const history = new Map();
  const patchText = patch("const a = 1;", "const a = 2;");
  history.set("foo.ts", [
    record("apply_patch_syntax_broken_post_write", 6, patchText, 1),
    record("apply_patch_syntax_broken_post_write", 6, patchText, 2),
  ]);
  const got = detectRepeatedFailure(history, "foo.ts");
  checks.push(check(
    "identical patch hash twice triggers escalation",
    got?.filePath === "foo.ts" && got?.reason === "identical_patch_retried",
    { got }
  ));
}

{
  const history = new Map();
  history.set("foo.ts", [
    record("apply_patch_syntax_broken_post_write", 6, patch("const a = 1;", "const a = 2;"), 1),
    record("apply_patch_syntax_broken_post_write", 6, patch("const b = 1;", "const b = 2;"), 2),
  ]);
  const got = detectRepeatedFailure(history, "foo.ts");
  checks.push(check(
    "same error line different patch triggers same root cause",
    got?.filePath === "foo.ts" && got?.reason === "same_root_cause_different_patch",
    { got }
  ));
}

{
  const history = new Map();
  history.set("foo.ts", [
    record("apply_patch_find_not_found", 1, patch("a", "b"), 1),
    record("apply_patch_find_not_found", 2, patch("c", "d"), 2),
    record("apply_patch_find_not_found", 3, patch("e", "f"), 3),
  ]);
  const got = detectRepeatedFailure(history, "foo.ts");
  checks.push(check(
    "three attempts same trigger escalates",
    got?.filePath === "foo.ts" && got?.reason === "trigger_repeated_3x",
    { got }
  ));
}

{
  const history = new Map();
  history.set("foo.ts", [
    record("apply_patch_find_not_found", null, patch("a", "b"), 1),
  ]);
  const got = detectRepeatedFailure(history, "foo.ts");
  checks.push(check("single failure does not trigger", got === null, { got }));
}

{
  const history = new Map();
  history.set("foo.ts", [
    record("apply_patch_find_not_found", null, patch("a", "b"), 1),
  ]);
  history.set("bar.ts", [
    record("apply_patch_find_not_found", null, patch("a", "b"), 2),
  ]);
  const fooGot = detectRepeatedFailure(history, "foo.ts");
  const barGot = detectRepeatedFailure(history, "bar.ts");
  checks.push(check(
    "different files remain independent per target",
    fooGot === null && barGot === null,
    { fooGot, barGot }
  ));
}

{
  const history = new Map();
  const patchText = patch("const a = 1;", "const a = 2;");
  history.set("foo.ts", [
    record("apply_patch_syntax_broken_post_write", 6, patchText, 1),
    record("apply_patch_syntax_broken_post_write", 6, patchText, 2),
  ]);
  const repeatPattern = detectRepeatedFailure(history, "foo.ts");
  const routedTrigger = repeatPattern
    ? "apply_patch_repeated_failure_same_file"
    : classifyFailure("apply_patch", "Patch applied but broke file syntax at line 6", undefined);
  checks.push(check(
    "routing override uses repeated failure trigger",
    routedTrigger === "apply_patch_repeated_failure_same_file",
    { routedTrigger }
  ));
}

{
  const text = buildCoachingPrompt(
    "apply_patch_repeated_failure_same_file",
    "",
    [],
    { attemptCount: 2, filePath: "foo.ts" }
  );
  checks.push(check(
    "coaching prompt names blocked write_file path",
    text.includes("STOP") && text.includes("BLOCKED") && text.includes("write_file"),
    { preview: text.slice(0, 220) }
  ));
}

{
  const history = new Map();
  const fooPatchText = patch("const a = 1;", "const a = 2;");
  history.set("bar.ts", [
    record("apply_patch_syntax_broken_post_write", 8, patch("const b = 1;", "const b = 2;"), 1),
  ]);
  history.set("foo.ts", [
    record("apply_patch_syntax_broken_post_write", 6, fooPatchText, 2),
    record("apply_patch_syntax_broken_post_write", 6, fooPatchText, 3),
  ]);
  const fooGot = detectRepeatedFailure(history, "foo.ts");
  const barGot = detectRepeatedFailure(history, "bar.ts");
  const nullGot = detectRepeatedFailure(history, null);
  checks.push(check(
    "multi-file target detects loop only for target file",
    fooGot?.filePath === "foo.ts" &&
      fooGot?.reason === "identical_patch_retried" &&
      barGot === null &&
      nullGot === null,
    { fooGot, barGot, nullGot }
  ));
}

{
  const history = new Map();
  const fooPatchText = patch("const a = 1;", "const a = 2;");
  history.set("foo.ts", [
    record("apply_patch_syntax_broken_post_write", 18, fooPatchText, 1),
    record("apply_patch_syntax_broken_post_write", 18, fooPatchText, 2),
  ]);
  history.set("bar.ts", [
    record("apply_patch_syntax_broken_post_write", 21, patch("const b = 1;", "const b = 2;"), 2),
  ]);

  const failedToolFilePath = "bar.ts";
  const failedFilesThisIter = new Set(["foo.ts", "bar.ts"]);
  const directGot = detectRepeatedFailure(history, failedToolFilePath);
  const fooGot = detectRepeatedFailure(history, "foo.ts");
  let sweptGot = directGot;
  if (!sweptGot) {
    for (const filePath of failedFilesThisIter) {
      if (filePath === failedToolFilePath) continue;
      const candidate = detectRepeatedFailure(history, filePath);
      if (candidate) {
        sweptGot = candidate;
        break;
      }
    }
  }

  checks.push(check(
    "backup sweep catches mid-batch repeated failure",
    directGot === null &&
      fooGot?.filePath === "foo.ts" &&
      fooGot?.reason === "identical_patch_retried" &&
      sweptGot?.filePath === "foo.ts" &&
      sweptGot?.reason === "identical_patch_retried",
    { directGot, fooGot, sweptGot }
  ));
}

const failed = checks.filter((c) => !c.pass);
console.log(
  `[repeated-failure-test] PASSED ${checks.length - failed.length}/${checks.length} assertions`
);
if (failed.length > 0) {
  process.exitCode = 1;
}
