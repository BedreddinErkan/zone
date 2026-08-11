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

  it("archetype=question: 18 absent, named", () => {
    const offered = new Set(["read_file", "run_command_readonly"]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "capabilityFilter", archetype: "question" });
    expect(block).toBe(
      "TOOLS NOT AVAILABLE THIS RUN — withheld by this task's archetype (question), not a permission error: " +
      "Task, TodoWrite, apply_patch, ask_user, fetch_url, find_references, kill_background, list_background, " +
      "list_files, multi_edit, read_background_output, revert_patch, run_command, run_command_background, " +
      "search_in_files, suggest_scope_change, update_memory, write_file. " +
      "Do not attempt these via another tool or a shell workaround.\n\n"
    );
  });

  it("archetype=investigation: 15 absent, named", () => {
    const offered = new Set(["read_file", "list_files", "search_in_files", "find_references", "run_command_readonly"]);
    const block = buildToolAbsenceBlock({ offeredToolNames: offered, filterSource: "capabilityFilter", archetype: "investigation" });
    expect(block).toBe(
      "TOOLS NOT AVAILABLE THIS RUN — withheld by this task's archetype (investigation), not a permission error: " +
      "Task, TodoWrite, apply_patch, ask_user, fetch_url, kill_background, list_background, multi_edit, " +
      "read_background_output, revert_patch, run_command, run_command_background, suggest_scope_change, " +
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
