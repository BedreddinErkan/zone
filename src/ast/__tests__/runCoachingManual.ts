/**
 * Manual test for the self-correction coaching router (Tier 2 Phase).
 *
 * Run with:
 *   node --experimental-strip-types src/ast/__tests__/runCoachingManual.ts
 *
 * No TS-specific syntax — compatible with Node.js 22 CJS-mode TS stripper.
 */
import { classifyFailure, buildCoachingPrompt } from "../../../dist/llm/agentLoop.js";

function check(label, pass, details) {
  console.log(
    "[assert] " + (pass ? "PASS" : "FAIL") + " " + label +
      (details !== undefined ? " :: " + JSON.stringify(details) : "")
  );
  return { label, pass, details };
}

const checks = [];

// ── classifyFailure tests ────────────────────────────────────────────────────

console.log("\n=== classifyFailure ===");

checks.push(check(
  "find_not_found classifies apply_patch",
  classifyFailure("apply_patch", "FIND content not found in file.ts", undefined) ===
    "apply_patch_find_not_found",
  { got: classifyFailure("apply_patch", "FIND content not found in file.ts", undefined) }
));

checks.push(check(
  "find_not_found via find_not_found keyword",
  classifyFailure("apply_patch", "find_not_found: the block does not exist", undefined) ===
    "apply_patch_find_not_found",
  {}
));

checks.push(check(
  "syntax_broken_post_write from 'broke file syntax'",
  classifyFailure("apply_patch", "Patch applied but broke file syntax at line 4", undefined) ===
    "apply_patch_syntax_broken_post_write",
  {}
));

checks.push(check(
  "syntax_broken_post_write from rejection string",
  classifyFailure("apply_patch", "", "syntax_broken_post_write") ===
    "apply_patch_syntax_broken_post_write",
  {}
));

checks.push(check(
  "semantic_smell from output wording",
  classifyFailure(
    "apply_patch",
    "Patch applied but produced semantically broken output. The smell detected was: broken_template_expression.",
    undefined
  ) === "apply_patch_semantic_smell",
  {}
));

checks.push(check(
  "semantic_smell from rejection string",
  classifyFailure("apply_patch", "", "semantic_smell_post_write") ===
    "apply_patch_semantic_smell",
  {}
));

checks.push(check(
  "multiple_matches from 'has 3 occurrences'",
  classifyFailure("apply_patch", "Scope symbol 'foo' has 3 occurrences (lines)", undefined) ===
    "apply_patch_multiple_matches",
  {}
));

checks.push(check(
  "multiple_matches from 'multiple matches'",
  classifyFailure("apply_patch", "multiple matches found in the file", undefined) ===
    "apply_patch_multiple_matches",
  {}
));

// Bug B fix: actual toolExecutor wording uses "matches K locations ... must be unique"
checks.push(check(
  "multiple_matches from 'matches 2 locations must be unique' (actual toolExecutor wording)",
  classifyFailure(
    "apply_patch",
    "Block 1: FIND content matches 2 locations within scope and must be unique.",
    undefined
  ) === "apply_patch_multiple_matches",
  {}
));

checks.push(check(
  "multiple_matches from standalone 'must be unique'",
  classifyFailure("apply_patch", "FIND must be unique to apply cleanly", undefined) ===
    "apply_patch_multiple_matches",
  {}
));

// replace_shorter_than_find routing (new trigger)
checks.push(check(
  "replace_shorter_than_find from actual toolExecutor wording",
  classifyFailure(
    "apply_patch",
    "Block 1: REPLACE has 2 lines but FIND has 4 lines.",
    undefined
  ) === "apply_patch_replace_shorter_than_find",
  {}
));

// find_block_empty routing (new trigger)
checks.push(check(
  "find_block_empty from actual toolExecutor wording",
  classifyFailure(
    "apply_patch",
    "Block 1: FIND block is empty. Provide exact lines to locate the insertion point.",
    undefined
  ) === "apply_patch_find_block_empty",
  {}
));

// pre_existing_broken: literal rejectionReason in text
checks.push(check(
  "pre_existing_broken from rejection reason literal",
  classifyFailure("apply_patch", "file_already_broken_pre_patch error", undefined) ===
    "apply_patch_pre_existing_broken",
  {}
));

// Bug fix: pre_existing_broken from actual toolExecutor output (no literal rejectionReason in output)
checks.push(check(
  "pre_existing_broken from NOT caused by your patch (actual output wording)",
  classifyFailure(
    "apply_patch",
    "The file is already syntactically broken at line 12, col 5. This is NOT caused by your patch.",
    undefined
  ) === "apply_patch_pre_existing_broken",
  {}
));

checks.push(check(
  "pre_existing_broken from 'already syntactically broken'",
  classifyFailure("apply_patch", "The file is already syntactically broken at line 5", undefined) ===
    "apply_patch_pre_existing_broken",
  {}
));

checks.push(check(
  "scope_not_found",
  classifyFailure("apply_patch", "Scope symbol 'bar' (kind: function) not found in foo.ts", undefined) ===
    "apply_patch_scope_not_found",
  {}
));

checks.push(check(
  "spawn failure from ENOENT",
  classifyFailure("run_command", "spawn cmd.exe ENOENT", undefined) ===
    "tool_command_spawn_failure",
  {}
));

checks.push(check(
  "spawn failure from missing script",
  classifyFailure("run_command", "npm ERR! missing script: test", undefined) ===
    "tool_command_spawn_failure",
  {}
));

checks.push(check(
  "test_failed from generic run_command failure",
  classifyFailure("run_command", "Exit code 1 tests failed", undefined) === "test_failed",
  {}
));

checks.push(check(
  "tool_path_enoent from ENOENT no such file",
  classifyFailure("read_file", "ENOENT: no such file or directory", undefined) ===
    "tool_path_enoent",
  {}
));

checks.push(check(
  "unknown for unrecognised pattern",
  classifyFailure("apply_patch", "some totally unknown error message", undefined) === "unknown",
  {}
));

// ── buildCoachingPrompt tests ────────────────────────────────────────────────

console.log("\n=== buildCoachingPrompt ===");

const allTriggers = [
  "apply_patch_find_not_found",
  "apply_patch_multiple_matches",
  "apply_patch_semantic_smell",
  "apply_patch_syntax_broken_post_write",
  "apply_patch_pre_existing_broken",
  "apply_patch_scope_not_found",
  "apply_patch_replace_shorter_than_find",
  "apply_patch_find_block_empty",
  "tool_command_spawn_failure",
  "tool_path_enoent",
  "test_failed",
  "unknown",
];

for (const trigger of allTriggers) {
  const text = buildCoachingPrompt(trigger, "sample error", []);
  checks.push(check(
    trigger + " returns non-empty string",
    typeof text === "string" && text.length > 0,
    { length: text.length }
  ));
  if (trigger === "apply_patch_scope_not_found") {
    checks.push(check(
      trigger + " tells the agent to remove scope",
      text.includes("REMOVE the scope parameter"),
      { preview: text.slice(0, 220) }
    ));
  } else {
    checks.push(check(
      trigger + " contains Next action:",
      text.includes("Next action:"),
      { preview: text.slice(-100) }
    ));
  }
}

// Spec-required content checks
checks.push(check(
  "semantic_smell prompt includes smell name",
  buildCoachingPrompt(
    "apply_patch_semantic_smell",
    "Patch applied but produced semantically broken output. The smell detected was: duplicate_jsx_attribute.",
    []
  ).includes("duplicate_jsx_attribute"),
  {}
));
checks.push(check(
  "semantic_smell prompt mentions conflicting old code",
  buildCoachingPrompt(
    "apply_patch_semantic_smell",
    "Patch applied but produced semantically broken output. The smell detected was: duplicate_jsx_attribute.",
    []
  ).includes("conflicting old code"),
  {}
));
checks.push(check(
  "semantic_smell prompt includes smell-specific guidance",
  buildCoachingPrompt(
    "apply_patch_semantic_smell",
    "Patch applied but produced semantically broken output. The smell detected was: inline_style_pseudo_class.",
    []
  ).includes("Inline React style does not support pseudo-classes"),
  {}
));
checks.push(check(
  "find_not_found prompt mentions read_file",
  buildCoachingPrompt("apply_patch_find_not_found", "", []).includes("read_file"),
  {}
));
checks.push(check(
  "find_not_found prompt mentions narrowing FIND block",
  buildCoachingPrompt("apply_patch_find_not_found", "", []).includes("narrow the FIND block"),
  {}
));
checks.push(check(
  "syntax_broken_post_write prompt mentions REPLACE block",
  buildCoachingPrompt("apply_patch_syntax_broken_post_write", "", []).includes("REPLACE block"),
  {}
));
checks.push(check(
  "syntax_broken_post_write prompt mentions read_file",
  buildCoachingPrompt("apply_patch_syntax_broken_post_write", "", []).includes("read_file"),
  {}
));
checks.push(check(
  "syntax_broken_post_write prompt mentions different from the last one",
  buildCoachingPrompt("apply_patch_syntax_broken_post_write", "", []).includes("different from the last one"),
  {}
));
checks.push(check(
  "syntax_broken_post_write prompt upgrades old wording with read_file mandate",
  buildCoachingPrompt("apply_patch_syntax_broken_post_write", "", []).includes("verified syntactically valid REPLACE block") &&
    buildCoachingPrompt("apply_patch_syntax_broken_post_write", "", []).includes("call read_file on the broken file"),
  {}
));
checks.push(check(
  "pre_existing_broken prompt mentions read_file",
  buildCoachingPrompt("apply_patch_pre_existing_broken", "", []).includes("read_file"),
  {}
));
checks.push(check(
  "pre_existing_broken prompt mentions ONE apply_patch",
  buildCoachingPrompt("apply_patch_pre_existing_broken", "", []).includes("ONE apply_patch"),
  {}
));
checks.push(check(
  "tool_command_spawn_failure prompt mentions cd chaining",
  buildCoachingPrompt("tool_command_spawn_failure", "", []).includes("cd <path> &&"),
  {}
));
checks.push(check(
  "unknown prompt mentions change ONE specific thing",
  buildCoachingPrompt("unknown", "", []).includes("change ONE specific thing"),
  {}
));
checks.push(check(
  "replace_shorter_than_find prompt mentions REPLACE and FIND",
  buildCoachingPrompt("apply_patch_replace_shorter_than_find", "", []).includes("REPLACE") &&
    buildCoachingPrompt("apply_patch_replace_shorter_than_find", "", []).includes("FIND"),
  {}
));
checks.push(check(
  "find_block_empty prompt mentions FIND",
  buildCoachingPrompt("apply_patch_find_block_empty", "", []).includes("FIND"),
  {}
));

// ── Summary ──────────────────────────────────────────────────────────────────

const failed = checks.filter((c) => !c.pass);
console.log("\n=== assert summary ===");
console.log(JSON.stringify(
  { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
  null, 2
));
if (failed.length > 0) {
  console.log("\nFailed checks:");
  for (const f of failed) {
    console.log("  FAIL:", f.label, f.details !== undefined ? JSON.stringify(f.details) : "");
  }
  process.exitCode = 1;
}
