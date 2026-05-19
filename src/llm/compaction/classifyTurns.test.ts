import { afterEach, describe, expect, it } from "vitest";
import { classifyTurns } from "./classifyTurns.js";
import { TurnClass, type ToolCallRecord } from "./types.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sys(): ChatCompletionMessageParam {
  return { role: "system", content: "sys" };
}

function userTurn(content = "task"): ChatCompletionMessageParam {
  return { role: "user", content };
}

function assistantTurn(content = "ok"): ChatCompletionMessageParam {
  return { role: "assistant", content };
}

function assistantWithTool(id: string, name: string): ChatCompletionMessageParam {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
  };
}

function toolResult(id: string, content = "result"): ChatCompletionMessageParam {
  return { role: "tool", tool_call_id: id, content };
}

/** N assistant filler turns (no tool_calls). */
function fillerTurns(n: number): ChatCompletionMessageParam[] {
  return Array.from({ length: n }, (_, i) => assistantTurn(`filler-${i}`));
}

function makeLog(entries: Array<{ id: string; tool: string; success: boolean }>): Array<ToolCallRecord> {
  return entries.map((e) => ({ id: e.id, tool: e.tool, args: {}, result: "", success: e.success }));
}

// ---------------------------------------------------------------------------
// Phase J.1 — PINNED turn class (audit_artifact)
// ---------------------------------------------------------------------------

describe("Phase J.1 — PINNED turn class", () => {
  it("pins assistant turn calling suggest_scope_change", () => {
    // total=17: sys(0), user(1), filler(2-11), audit-assistant(12), audit-result(13), filler(14-16)
    // recency window starts at idx 14 (17-3=14)
    // idx 12 is CANDIDATE in old logic, now PINNED by PINNED_TOOLS
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      ...fillerTurns(10),                              // 2-11
      assistantWithTool("call_audit", "suggest_scope_change"), // 12
      toolResult("call_audit", "scope ok"),            // 13
      ...fillerTurns(3),                               // 14-16 (recency)
    ];
    const result = classifyTurns(history, []);

    expect(result[12].class).toBe(TurnClass.PINNED);
    expect(result[12].reason).toBe("audit_artifact");
    expect(result[12].pinReason).toBe("audit_artifact");
  });

  it("pair-propagates PINNED from audit assistant to its tool result", () => {
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      ...fillerTurns(10),
      assistantWithTool("call_audit", "suggest_scope_change"), // 12
      toolResult("call_audit", "scope ok"),                   // 13
      ...fillerTurns(3),                                       // 14-16 (recency)
    ];
    const result = classifyTurns(history, []);

    // idx 13 is CANDIDATE in Pass 1, pair-propagated to PINNED from idx 12
    expect(result[13].class).toBe(TurnClass.PINNED);
    expect(result[13].reason).toBe("pair_with_pinned_tool_call");
    expect(result[13].pinReason).toBe("audit_artifact");
  });

  it("audit turn stays PINNED when far from recency window", () => {
    // 40 total turns, audit at idx 5 — well outside recency window (starts at 37)
    const history: ChatCompletionMessageParam[] = [
      sys(),                                                   // 0
      userTurn(),                                              // 1
      ...fillerTurns(3),                                       // 2-4
      assistantWithTool("call_audit", "suggest_scope_change"), // 5
      toolResult("call_audit", "scope result"),                // 6
      ...fillerTurns(33),                                      // 7-39 (recency starts at 37)
    ];
    const result = classifyTurns(history, []);
    expect(result[5].class).toBe(TurnClass.PINNED);
    expect(result[5].pinReason).toBe("audit_artifact");
    expect(result[6].class).toBe(TurnClass.PINNED);
  });

  it("non-PINNED, non-recent turns remain CANDIDATE when no audit or failures", () => {
    // 30 turns, no audit, no failures — most should be CANDIDATE
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      ...fillerTurns(27),  // 2-28, all CANDIDATE (not in recency window idx 27-29)
      ...fillerTurns(1),   // 29 (recency)
    ];
    const result = classifyTurns(history, []);
    const candidates = result.filter((r) => r.class === TurnClass.CANDIDATE);
    // sys(VERBATIM) + user(VERBATIM) + last-3(VERBATIM) = 5 non-CANDIDATE; rest CANDIDATE
    expect(candidates.length).toBeGreaterThan(20);
    expect(result[0].class).toBe(TurnClass.VERBATIM);  // system
    expect(result[1].class).toBe(TurnClass.VERBATIM);  // initial user
  });

  it("existing pair_with_verbatim_tool_result reason preserved for non-PINNED propagation", () => {
    // Recency window tool result propagates to its CANDIDATE assistant as VERBATIM
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "list_files", arguments: "{}" } }] },
      toolResult("call_1", "files"),
      assistantTurn("ok"),
      userTurn("next"),
    ];
    // total=6, recency starts at idx 3; idx 2 is CANDIDATE until pair-prop
    const result = classifyTurns(history, []);
    expect(result[2].class).toBe(TurnClass.VERBATIM);
    expect(result[2].reason).toBe("pair_with_verbatim_tool_result");
    // No pinReason on VERBATIM turns from non-PINNED propagation
    expect(result[2].pinReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase J.2 — Failure history pin (recent_failure)
// ---------------------------------------------------------------------------

describe("Phase J.2 — Failure history pin", () => {
  it("pins latest 3 failures out of 5 via toolCallLog success===false", () => {
    // Build explicit history with 5 failure pairs at predictable positions.
    // total=28: sys(0), user(1), then 5 failure pairs + filler, then recency(25-27)
    const history: ChatCompletionMessageParam[] = [
      sys(),     // 0
      userTurn(), // 1
      assistantWithTool("f0", "run_cmd"), // 2
      toolResult("f0", "error"),         // 3 — failure #1 (oldest)
      assistantWithTool("f1", "run_cmd"), // 4
      toolResult("f1", "error"),         // 5 — failure #2
      assistantWithTool("f2", "run_cmd"), // 6
      toolResult("f2", "error"),         // 7 — failure #3
      assistantWithTool("f3", "run_cmd"), // 8
      toolResult("f3", "error"),         // 9 — failure #4
      assistantWithTool("f4", "run_cmd"), // 10
      toolResult("f4", "error"),         // 11 — failure #5 (newest, before recency)
      ...fillerTurns(13),                // 12-24
      // recency: 25-27
      ...fillerTurns(3),
    ];
    const log = makeLog([
      { id: "f0", tool: "run_cmd", success: false },
      { id: "f1", tool: "run_cmd", success: false },
      { id: "f2", tool: "run_cmd", success: false },
      { id: "f3", tool: "run_cmd", success: false },
      { id: "f4", tool: "run_cmd", success: false },
    ]);
    const result = classifyTurns(history, log);

    // Newest 3 failures pinned: f4(11), f3(9), f2(7) — and their assistant callers
    expect(result[11].class).toBe(TurnClass.PINNED);
    expect(result[11].pinReason).toBe("recent_failure");
    expect(result[10].class).toBe(TurnClass.PINNED); // paired assistant for f4
    expect(result[9].class).toBe(TurnClass.PINNED);
    expect(result[8].class).toBe(TurnClass.PINNED);  // paired assistant for f3
    expect(result[7].class).toBe(TurnClass.PINNED);
    expect(result[6].class).toBe(TurnClass.PINNED);  // paired assistant for f2

    // Older failures (f0, f1) remain CANDIDATE
    expect(result[3].class).toBe(TurnClass.CANDIDATE);
    expect(result[5].class).toBe(TurnClass.CANDIDATE);
  });

  it("pins via content regex when no toolCallLog entry", () => {
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      assistantWithTool("c1", "bash"), // 2
      toolResult("c1", "Error: module not found"), // 3 — matches regex, no log entry
      ...fillerTurns(10),
      ...fillerTurns(3), // recency
    ];
    const result = classifyTurns(history, []); // empty log

    expect(result[3].class).toBe(TurnClass.PINNED);
    expect(result[3].pinReason).toBe("recent_failure");
  });

  it("does NOT pin Phase F verifier warnings as failures", () => {
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      assistantWithTool("c1", "apply_patch"), // 2
      toolResult("c1", "Patch applied. VERIFICATION WARNINGS: 3 new TS errors detected, kept on disk."), // 3
      ...fillerTurns(10),
      ...fillerTurns(3), // recency
    ];
    // No log record for c1 → falls through to content check → excluded by VERIFICATION WARNINGS
    const result = classifyTurns(history, []);
    // apply_patch assistant is VERBATIM (protected_tool), tool result is CANDIDATE (no log)
    expect(result[3].class).not.toBe(TurnClass.PINNED);
    expect(result[3].class).not.toBe(TurnClass.PINNED);
  });

  it("does NOT pin [VERIFY-WARN] content", () => {
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      assistantWithTool("c1", "bash"),  // 2
      toolResult("c1", "[VERIFY-WARN] typecheck found 2 issues"),  // 3
      ...fillerTurns(10),
      ...fillerTurns(3),
    ];
    const result = classifyTurns(history, []);
    expect(result[3].class).not.toBe(TurnClass.PINNED);
  });

  it("respects ZONE_FAILURE_PIN_DEPTH=1 env override", () => {
    process.env.ZONE_FAILURE_PIN_DEPTH = "1";
    try {
      const history: ChatCompletionMessageParam[] = [
        sys(),
        userTurn(),
        assistantWithTool("f0", "bash"), // 2
        toolResult("f0", "error"),       // 3 — older failure
        assistantWithTool("f1", "bash"), // 4
        toolResult("f1", "error"),       // 5 — newer failure
        ...fillerTurns(10),
        ...fillerTurns(3), // recency
      ];
      const log = makeLog([
        { id: "f0", tool: "bash", success: false },
        { id: "f1", tool: "bash", success: false },
      ]);
      const result = classifyTurns(history, log);

      // Only the newest failure (f1 at idx 5) should be pinned
      const pinnedFailures = result.filter((r) => r.pinReason === "recent_failure");
      // 1 failure tool result + 1 paired assistant = 2 PINNED turns
      expect(pinnedFailures).toHaveLength(2);
      expect(result[5].class).toBe(TurnClass.PINNED);
      expect(result[3].class).toBe(TurnClass.CANDIDATE); // older failure not pinned
    } finally {
      delete process.env.ZONE_FAILURE_PIN_DEPTH;
    }
  });

  it("pair-propagates failure pin to matching assistant turn", () => {
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      ...fillerTurns(8),                // 2-9
      assistantWithTool("f0", "bash"),  // 10
      toolResult("f0", "error"),        // 11 — failure
      ...fillerTurns(7),                // 12-18
      ...fillerTurns(3),                // 19-21 (recency)
    ];
    const log = makeLog([{ id: "f0", tool: "bash", success: false }]);
    const result = classifyTurns(history, log);

    expect(result[11].class).toBe(TurnClass.PINNED);
    expect(result[11].pinReason).toBe("recent_failure");
    // Paired assistant at idx 10 should also be pinned
    expect(result[10].class).toBe(TurnClass.PINNED);
    expect(result[10].pinReason).toBe("recent_failure");
  });

  it("skips already-VERBATIM or PINNED turns in failure scan", () => {
    // apply_patch failure is already VERBATIM (rollback_context) — should not be re-pinned
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      assistantWithTool("p0", "apply_patch"), // 2
      toolResult("p0", "patch failed"),       // 3 — VERBATIM rollback_context
      ...fillerTurns(10),
      ...fillerTurns(3),
    ];
    const log = makeLog([{ id: "p0", tool: "apply_patch", success: false }]);
    const result = classifyTurns(history, log);

    // Should be rollback_context (VERBATIM), not re-classified as recent_failure (PINNED)
    expect(result[3].class).toBe(TurnClass.VERBATIM);
    expect(result[3].reason).toBe("rollback_context");
    expect(result[3].pinReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Combined J.1 + J.2 — both active simultaneously
// ---------------------------------------------------------------------------

describe("Phase J.1 + J.2 combined", () => {
  it("audit pin and failure pin both active in the same history", () => {
    const history: ChatCompletionMessageParam[] = [
      sys(),
      userTurn(),
      assistantWithTool("audit", "suggest_scope_change"), // 2 — PINNED audit
      toolResult("audit", "scope ok"),                    // 3 — pair-propagated PINNED
      ...fillerTurns(5),                                  // 4-8
      assistantWithTool("fail", "bash"),                  // 9
      toolResult("fail", "Error: build failed"),          // 10 — PINNED failure (content regex)
      ...fillerTurns(5),                                  // 11-15
      ...fillerTurns(3),                                  // 16-18 (recency)
    ];
    const result = classifyTurns(history, []);

    expect(result[2].class).toBe(TurnClass.PINNED);
    expect(result[2].pinReason).toBe("audit_artifact");
    expect(result[3].class).toBe(TurnClass.PINNED);
    expect(result[10].class).toBe(TurnClass.PINNED);
    expect(result[10].pinReason).toBe("recent_failure");
    expect(result[9].class).toBe(TurnClass.PINNED);
    expect(result[9].pinReason).toBe("recent_failure");
  });
});
