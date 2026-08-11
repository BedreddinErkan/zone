import { describe, it, expect } from "vitest";
import { buildToolAbsenceBlock } from "./toolAbsenceNotice.js";

// Hardcoded, not derived via the same filter/sort the implementation uses —
// a test computing its expectation the same way the code does would pin
// nothing. Transcribed from a verified run against the built function at
// commit 69630cb0, cross-checked against the six-configuration prediction
// table by hand before that commit landed.

describe("buildToolAbsenceBlock — six measured configurations, by name", () => {
  it("tier=simple: 15 absent, named", () => {
    const offered = new Set(["run_command", "read_file", "apply_patch", "multi_edit", "write_file"]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "tierFilterFromClassifier", tier: "simple" });
    expect(block).toBe(
      "TOOLS NOT AVAILABLE THIS RUN — withheld by this task's tier (simple), not a permission error: " +
      "Task, TodoWrite, ask_user, fetch_url, find_references, kill_background, list_background, list_files, " +
      "read_background_output, revert_patch, run_command_background, run_command_readonly, search_in_files, " +
      "suggest_scope_change, update_memory. Do not attempt these via another tool or a shell workaround.\n\n"
    );
  });

  it("tier=medium: 11 absent, named", () => {
    const offered = new Set([
      "run_command", "TodoWrite", "read_file", "list_files", "apply_patch",
      "multi_edit", "write_file", "search_in_files", "find_references",
    ]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "tierFilterFromClassifier", tier: "medium" });
    expect(block).toBe(
      "TOOLS NOT AVAILABLE THIS RUN — withheld by this task's tier (medium), not a permission error: " +
      "Task, ask_user, fetch_url, kill_background, list_background, read_background_output, revert_patch, " +
      "run_command_background, run_command_readonly, suggest_scope_change, update_memory. " +
      "Do not attempt these via another tool or a shell workaround.\n\n"
    );
  });

  // run_command dropped from 18 to 17 (collision fix, this arc): run_command_readonly
  // is offered here and run_command is a strict prefix of it — naming the withheld
  // root reads as covering the offered, more specific tool. Measured causal (this
  // arc's behavioural establish): an agent holding run_command_readonly stopped using
  // the shell entirely once "run_command" was named withheld alongside it, and twice
  // reported a false negative it could have resolved with one command it already had.
  // run_command_background stays named — it is not a prefix of run_command_readonly
  // (diverges after "run_command_": "background" vs "readonly"), so nothing about it
  // is misleading here.
  it("archetype=question: 17 absent, named (run_command suppressed — collision with offered run_command_readonly)", () => {
    const offered = new Set(["read_file", "run_command_readonly"]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "capabilityFilter", archetype: "question" });
    expect(block).toBe(
      "TOOLS NOT AVAILABLE THIS RUN — withheld by this task's archetype (question), not a permission error: " +
      "Task, TodoWrite, apply_patch, ask_user, fetch_url, find_references, kill_background, list_background, " +
      "list_files, multi_edit, read_background_output, revert_patch, run_command_background, " +
      "search_in_files, suggest_scope_change, update_memory, write_file. " +
      "Do not attempt these via another tool or a shell workaround.\n\n"
    );
  });

  // Same collision as the question case above: run_command_readonly is offered,
  // run_command is a strict prefix of it, so run_command drops from the named list
  // (15 -> 14). run_command_background stays named for the same reason as above.
  it("archetype=investigation: 14 absent, named (run_command suppressed — collision with offered run_command_readonly)", () => {
    const offered = new Set(["read_file", "list_files", "search_in_files", "find_references", "run_command_readonly"]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "capabilityFilter", archetype: "investigation" });
    expect(block).toBe(
      "TOOLS NOT AVAILABLE THIS RUN — withheld by this task's archetype (investigation), not a permission error: " +
      "Task, TodoWrite, apply_patch, ask_user, fetch_url, kill_background, list_background, multi_edit, " +
      "read_background_output, revert_patch, run_command_background, suggest_scope_change, " +
      "update_memory, write_file. Do not attempt these via another tool or a shell workaround.\n\n"
    );
  });

  it("archetype=targeted_fix/refactor: full set offered, emits nothing — byte-identical prompt requirement", () => {
    const offered = new Set([
      "Task", "TodoWrite", "apply_patch", "ask_user", "fetch_url", "find_references",
      "kill_background", "list_background", "list_files", "multi_edit", "read_background_output",
      "read_file", "revert_patch", "run_command", "run_command_background", "run_command_readonly",
      "search_in_files", "suggest_scope_change", "update_memory", "write_file",
    ]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "capabilityFilter", archetype: "targeted_fix" });
    expect(block).toBe("");
  });

  it("archetype=simple_add: 2 absent, named", () => {
    const offered = new Set([
      "run_command", "TodoWrite", "kill_background", "list_background", "read_background_output",
      "run_command_background", "read_file", "list_files", "apply_patch", "multi_edit", "write_file",
      "search_in_files", "find_references", "update_memory", "run_command_readonly", "ask_user",
      "revert_patch", "fetch_url",
    ]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "capabilityFilter", archetype: "simple_add" });
    expect(block).toBe(
      "TOOLS NOT AVAILABLE THIS RUN — withheld by this task's archetype (simple_add), not a permission error: " +
      "Task, suggest_scope_change. Do not attempt these via another tool or a shell workaround.\n\n"
    );
  });
});

describe("buildToolAbsenceBlock — remaining filterSource arms", () => {
  it('filterSource="modeDefault" names the mode', () => {
    const offered = new Set(["read_file", "list_files"]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "modeDefault", mode: "investigate" });
    expect(block).toContain("withheld by this run's mode (investigate), not a permission error");
  });

  it('filterSource="allowedTools" states the restriction came from the caller, no reason invented', () => {
    const offered = new Set(["read_file"]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "allowedTools" });
    expect(block).toContain("withheld by a tool list set by the caller, not a permission error");
    // No tier/archetype/mode word appears — the cause names the caller, not a fabricated reason.
    expect(block).not.toMatch(/tier|archetype|mode \(/);
  });

  it('filterSource="none" with a non-empty gap (excludeTools/budget-gating, no tier/archetype/mode fact) reads honestly', () => {
    const offered = new Set([
      "TodoWrite", "apply_patch", "ask_user", "fetch_url", "find_references", "kill_background",
      "list_background", "list_files", "multi_edit", "read_background_output", "read_file",
      "revert_patch", "run_command", "run_command_background", "run_command_readonly",
      "search_in_files", "suggest_scope_change", "update_memory", "write_file",
      // Task omitted — the taskBlockedByBudget shape, with no capabilityFilter selected.
    ]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "none" });
    expect(block).toBe(
      "TOOLS NOT AVAILABLE THIS RUN — withheld by this run's own configuration, not a permission error: " +
      "Task. Do not attempt these via another tool or a shell workaround.\n\n"
    );
  });
});

describe("buildToolAbsenceBlock — determinism", () => {
  it("two calls with identical input produce byte-identical output (the cache-prefix-stability property)", () => {
    const input = {
      offeredToolNames: new Set(["run_command", "TodoWrite", "read_file", "list_files", "apply_patch"]),
      filterSource: "tierFilterFromClassifier" as const,
      tier: "medium",
    };
    const first = buildToolAbsenceBlock(input);
    const second = buildToolAbsenceBlock({ ...input, offeredToolNames: new Set(input.offeredToolNames) });
    expect(first).toBe(second);
  });
});

describe("buildToolAbsenceBlock — collision suppression, both directions", () => {
  // The reverse direction on purpose: run_command is OFFERED, run_command_readonly
  // and run_command_background are WITHHELD. Neither withheld name is a prefix of
  // "run_command" (both are longer), so neither qualifies for suppression — the
  // offered tool is a strict superset here, naming the narrower siblings absent is
  // true and harmless, and this direction is left untouched by design (not merely
  // by omission — see the tier=simple/medium cases above, which pin the same fact
  // as an incidental consequence of unrelated measured-configuration tests; this one
  // names the property directly).
  it("reverse direction is NOT suppressed: run_command offered, run_command_readonly/run_command_background stay named", () => {
    const offered = new Set(["run_command", "read_file", "apply_patch", "multi_edit", "write_file"]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "tierFilterFromClassifier", tier: "simple" });
    expect(block).toContain("run_command_readonly");
    expect(block).toContain("run_command_background");
    // And run_command itself must not appear in the absent list — it's offered, not
    // withheld. Checked via the tool's own list-boundary (comma/period), not a bare
    // substring match, since "run_command" is itself a substring of both siblings above.
    expect(block).not.toMatch(/(^|, )run_command(,|\.)/);
  });

  // The empty-absent early return fires before the new filter runs at all (see
  // source), so a full-toolset run is untouched by this fix — re-checked explicitly
  // here, in this fix's own test, rather than relying only on the pre-existing
  // byte-stability test above to carry it.
  it("full toolset offered: still empty, the new filter is a no-op on an already-empty absent list", () => {
    const offered = new Set([
      "Task", "TodoWrite", "apply_patch", "ask_user", "fetch_url", "find_references",
      "kill_background", "list_background", "list_files", "multi_edit", "read_background_output",
      "read_file", "revert_patch", "run_command", "run_command_background", "run_command_readonly",
      "search_in_files", "suggest_scope_change", "update_memory", "write_file",
    ]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "capabilityFilter", archetype: "targeted_fix" });
    expect(block).toBe("");
  });
});
