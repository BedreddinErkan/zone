import { describe, it, expect } from "vitest";
import { mapStructuredEventToProgress } from "./runLlmPatchFlow.js";

const CASES: [string, object][] = [
  // Approval events
  ["command_approval_required", { type: "command_approval_required", command: "ls",       approvalId: "a1" }],
  ["edit_approval_required",    { type: "edit_approval_required",    filePath: "foo.ts",  approvalId: "a2" }],
  ["command_auto_approved",     { type: "command_auto_approved",     command: "ls",       approvalId: "a3" }],
  ["command_trusted",           { type: "command_trusted",           command: "ls",       approvalId: "a4" }],
  // Narration / budget
  ["narration",                 { type: "narration",                 title: "t",   text: "x" }],
  ["token_budget_status",       { type: "token_budget_status",       title: "budget" }],
  // Subagent lifecycle
  ["subagent_started",          { type: "subagent_started",          subagentId: "s1", title: "started" }],
  ["subagent_completed",        { type: "subagent_completed",        subagentId: "s1", title: "done" }],
  // Compaction events
  ["compaction_started",        { type: "compaction_started",        title: "compacting" }],
  ["compaction_status",         { type: "compaction_status",         title: "50%", count: 1 }],
  ["compaction_exhausted",      { type: "compaction_exhausted",      title: "done" }],
  ["compaction_overflow_warning", { type: "compaction_overflow_warning", title: "overflow" }],
  // Loop events
  ["loop_warning_emitted",      { type: "loop_warning_emitted",      title: "loop",     toolName: "run_command", count: 3 }],
  ["loop_detected_terminal",    { type: "loop_detected_terminal",    title: "terminal", toolName: "run_command", count: 5 }],
  // Staged-checkpoint approval (regression guard — was missing, causing silent drop)
  ["staged_diffs_ready_for_approval", { type: "staged_diffs_ready_for_approval", approvalId: "a5", stagedFilesJson: "[]", stagedVerificationSummary: "tsc ✓", stagedTrigger: "natural_completion" }],
];

describe("mapStructuredEventToProgress", () => {
  it.each(CASES)("maps %s to non-null progress with correct type", (expectedType, input) => {
    const result = mapStructuredEventToProgress(input);
    expect(result).not.toBeNull();
    expect(result?.type).toBe(expectedType);
  });

  it("staged_diffs_ready_for_approval forwards approvalId, stagedFilesJson, stagedVerificationSummary, stagedTrigger", () => {
    const result = mapStructuredEventToProgress({
      type: "staged_diffs_ready_for_approval",
      approvalId: "uuid-staged",
      stagedFilesJson: '[{"path":"src/a.ts"}]',
      stagedVerificationSummary: "tsc clean",
      stagedTrigger: "max_iterations",
    });
    expect(result).not.toBeNull();
    expect(result?.approvalId).toBe("uuid-staged");
    expect((result as any).stagedFilesJson).toBe('[{"path":"src/a.ts"}]');
    expect((result as any).stagedVerificationSummary).toBe("tsc clean");
    expect((result as any).stagedTrigger).toBe("max_iterations");
  });

  it("edit_approval_required forwards filePath and approvalId", () => {
    const result = mapStructuredEventToProgress({
      type: "edit_approval_required",
      filePath: "src/utils/helper.ts",
      approvalId: "uuid-123",
    });
    expect(result).not.toBeNull();
    expect(result?.filePath).toBe("src/utils/helper.ts");
    expect(result?.approvalId).toBe("uuid-123");
  });

  it("returns null for unknown event type", () => {
    expect(mapStructuredEventToProgress({ type: "totally_unknown" })).toBeNull();
  });

  it("returns null for side-effect-only types (not in mapping)", () => {
    expect(mapStructuredEventToProgress({ type: "iter_cost_update" })).toBeNull();
    expect(mapStructuredEventToProgress({ type: "todos_initialized" })).toBeNull();
    expect(mapStructuredEventToProgress({ type: "todo_revised" })).toBeNull();
    expect(mapStructuredEventToProgress({ type: "todo_status_changed" })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(mapStructuredEventToProgress(null)).toBeNull();
    expect(mapStructuredEventToProgress("string")).toBeNull();
    expect(mapStructuredEventToProgress(42)).toBeNull();
    expect(mapStructuredEventToProgress(undefined)).toBeNull();
  });
});
