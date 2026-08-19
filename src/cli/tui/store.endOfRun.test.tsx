import { describe, it, expect } from "vitest";
import { reducer, buildInitialState } from "./store.js";
import type { StoreAction, StoreState, TranscriptEntry } from "./store.js";

/**
 * Two independent end-of-run defects from a real dogfood run at aa46f885. They are pinned in one
 * file because both are properties of the same committed transcript, but they share no mechanism —
 * one is a duplicate render, the other is action ordering — and each has its own describe block.
 *
 * Both were established by driving the real reducer rather than by reading it, and both assertions
 * below reproduce that instrument: dispatch a realistic sequence, then read the committed
 * transcript. Nothing here mocks the reducer or the entry shapes.
 */

const PATCH = "--- FIND ---\nconst a = 1;\n--- REPLACE ---\nconst a = 2;";

function apply(state: StoreState, actions: StoreAction[]): StoreState {
  return actions.reduce(reducer, state);
}

/** One completed tool call: open, then a result that commits it (or buffers it, for reads). */
function toolCall(
  toolName: string,
  args: string,
  opts: { patch?: string; ok?: boolean } = {}
): StoreAction[] {
  return [
    { type: "TOOL_CALL_OPEN", toolName, args, patch: opts.patch },
    { type: "TOOL_RESULT_PUSH", ok: opts.ok ?? true, detail: "ok" },
    { type: "TOOL_CALL_CLOSE" },
  ];
}

function stagedFiles(...paths: string[]) {
  return paths.map((path) => ({ path, findReplace: PATCH, added: 1, removed: 1 }));
}

function postExecuteEntry(state: StoreState): Extract<TranscriptEntry, { kind: "post_execute_diffs" }> {
  const entry = state.transcript.find((e) => e.kind === "post_execute_diffs");
  if (!entry || entry.kind !== "post_execute_diffs") throw new Error("no post_execute_diffs entry");
  return entry;
}

describe("defect 1 — the end-of-run block does not repeat a diff already shown inline", () => {
  it("suppresses the diff for an apply_patch whose patch already rendered inline", () => {
    let state = buildInitialState({});
    state = apply(state, toolCall("apply_patch", "src/a.ts", { patch: PATCH }));
    state = apply(state, [{ type: "POST_EXECUTE_DIFFS", files: stagedFiles("src/a.ts") }]);

    expect(postExecuteEntry(state).diffShownInline).toEqual(["src/a.ts"]);
  });

  /**
   * The case that makes blanket-dropping the diff wrong, and the reason this is computed per file:
   * buildToolCallPatch only builds an inline patch for write_file when the file is NEW
   * (beforeContent === ""). An overwrite therefore has no inline diff anywhere, so the end-of-run
   * block is its only rendering and must keep it.
   */
  it("keeps the diff for a write_file overwrite, which has no inline patch at all", () => {
    let state = buildInitialState({});
    state = apply(state, toolCall("write_file", "src/b.ts")); // no patch — an overwrite
    state = apply(state, [{ type: "POST_EXECUTE_DIFFS", files: stagedFiles("src/b.ts") }]);

    expect(postExecuteEntry(state).diffShownInline).toEqual([]);
  });

  it("suppresses the diff for a write_file creating a NEW file, which does render inline", () => {
    let state = buildInitialState({});
    state = apply(state, toolCall("write_file", "src/c.ts", { patch: PATCH }));
    state = apply(state, [{ type: "POST_EXECUTE_DIFFS", files: stagedFiles("src/c.ts") }]);

    expect(postExecuteEntry(state).diffShownInline).toEqual(["src/c.ts"]);
  });

  /**
   * multi_edit's identifying arg is a summary string ("N files · find=…"), never a path, so it can
   * never match a staged path — which is correct, because its inline patch shows the single
   * find→replace transformation, not the real per-file result.
   */
  it("keeps the diff for every file of a multi_edit", () => {
    let state = buildInitialState({});
    state = apply(state, toolCall("multi_edit", '2 files · find="x" · src/d.ts, src/e.ts', { patch: PATCH }));
    state = apply(state, [{ type: "POST_EXECUTE_DIFFS", files: stagedFiles("src/d.ts", "src/e.ts") }]);

    expect(postExecuteEntry(state).diffShownInline).toEqual([]);
  });

  /** ToolCall.tsx renders no diff for a failed call, so the summary block must still show one. */
  it("keeps the diff for an apply_patch that failed", () => {
    let state = buildInitialState({});
    state = apply(state, toolCall("apply_patch", "src/f.ts", { patch: PATCH, ok: false }));
    state = apply(state, [{ type: "POST_EXECUTE_DIFFS", files: stagedFiles("src/f.ts") }]);

    expect(postExecuteEntry(state).diffShownInline).toEqual([]);
  });
});

describe("defect 2 — the final report is the last thing committed", () => {
  /**
   * The executed sequence that surfaced this: reads buffer into pendingReadOnlyBatch, and only a
   * flush commits them. ASSISTANT_FINAL did not flush, so RUN_DONE's own flush landed the group
   * BELOW the report. eventToActions pushes ASSISTANT_FINAL then RUN_DONE within the single
   * agent_loop_complete event, so this was never a cross-event race — it is one action list.
   */
  it("flushes buffered read-only calls BEFORE appending the report", () => {
    let state = buildInitialState({});
    state = apply(state, toolCall("read_file", "src/baz.ts"));
    state = apply(state, toolCall("read_file", "src/qux.ts"));
    // Both reads are still buffered — nothing has committed them yet.
    expect(state.liveTail.pendingReadOnlyBatch).toHaveLength(2);

    state = apply(state, [
      { type: "ASSISTANT_FINAL", text: "## What changed\nUpdated the constant." },
      { type: "RUN_DONE" },
    ]);

    const kinds = state.transcript.map((e) => e.kind);
    expect(kinds).toEqual(["tool_call_group", "assistant_final"]);
    expect(state.transcript[state.transcript.length - 1]!.kind).toBe("assistant_final");
  });

  it("leaves nothing buffered, so RUN_DONE's own flush has nothing left to append", () => {
    let state = buildInitialState({});
    state = apply(state, toolCall("read_file", "src/baz.ts"));
    state = apply(state, [{ type: "ASSISTANT_FINAL", text: "report" }]);

    expect(state.liveTail.pendingReadOnlyBatch).toEqual([]);
  });

  it("is a no-op when nothing is buffered — a report with no preceding reads still commits alone", () => {
    let state = buildInitialState({});
    state = apply(state, [{ type: "ASSISTANT_FINAL", text: "report" }]);

    expect(state.transcript.map((e) => e.kind)).toEqual(["assistant_final"]);
  });
});
