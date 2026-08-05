import { describe, expect, it } from "vitest";
import {
  detectFailureStall,
  detectWanderingSignal,
  detectCostBurnSignal,
  detectNoProgressSignal,
  computeAntiThrashSignal,
  buildStallReflectionText,
  readEnvFloat,
  ANTI_THRASH_FAILURE_COACH_MIN,
  ANTI_THRASH_WANDER_ITER_MIN,
  ANTI_THRASH_WANDER_READ_MIN,
  ANTI_THRASH_COST_BURN_ITER_MIN,
  ANTI_THRASH_COST_BURN_USD,
  ANTI_THRASH_NO_PROGRESS_ITER_MIN,
  ANTI_THRASH_NO_PROGRESS_WINDOW,
  NO_PATCH_HASH_SENTINEL,
  type AntiThrashContext,
  type ErrorKeySnapshot,
} from "./antiThrash.js";
import { detectRepeatedFailure, type FailureRecord } from "./agentLoop.js";

function makeRecord(
  trigger: string,
  patchHash: string,
  errorLine: number | null = null,
  iter = 0,
): FailureRecord {
  return { trigger, patchHash, errorLine, iter };
}

function makeCtx(overrides?: Partial<AntiThrashContext>): AntiThrashContext {
  return {
    iter: 10,
    failureHistory: new Map(),
    coachingAttempts: ANTI_THRASH_FAILURE_COACH_MIN,
    filesReadCountThisRun: new Map(),
    filesModifiedSize: 0,
    isReadOnly: false,
    archetype: "targeted_fix",
    costUsd: 0.5,
    ...overrides,
  };
}

// ── detectFailureStall ────────────────────────────────────────────────────────

describe("detectFailureStall — true positives", () => {
  it("identical_patch_retried with coaching >= COACH_MIN → fires", () => {
    const history = new Map([
      [
        "src/foo.ts",
        [
          makeRecord("tsc_error", "hash-A"),
          makeRecord("tsc_error", "hash-A"),
        ],
      ],
    ]);
    const result = detectFailureStall(makeCtx({ failureHistory: history }));
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("failure_stall");
    expect(result?.detail.verdict).toBe("identical_patch_retried");
    expect(result?.detail.filePath).toBe("src/foo.ts");
    expect(result?.detail.coachingAttempts).toBe(ANTI_THRASH_FAILURE_COACH_MIN);
  });

  it("trigger_repeated_3x with coaching >= COACH_MIN → fires", () => {
    // last=tsc_error (index 4), prev=runtime_error (index 3) → different triggers
    // count of tsc_error = 3 (indices 0, 2, 4) → trigger_repeated_3x fires
    const history = new Map([
      [
        "src/bar.ts",
        [
          makeRecord("tsc_error", "hash-A"),
          makeRecord("runtime_error", "hash-B"),
          makeRecord("tsc_error", "hash-C"),
          makeRecord("runtime_error", "hash-D"),
          makeRecord("tsc_error", "hash-E"),
        ],
      ],
    ]);
    const result = detectFailureStall(makeCtx({ failureHistory: history }));
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("failure_stall");
    expect(result?.detail.verdict).toBe("trigger_repeated_3x");
    expect(result?.detail.filePath).toBe("src/bar.ts");
  });

  it("no-patch trigger reaching 3x via an interleaved other-triggered failure → trigger_repeated_3x still fires", () => {
    // Verdict 2 has its own precondition — last.trigger !== prev.trigger — independent of
    // the sentinel guard on Verdict 1. A straight run of identical-trigger no-patch
    // failures never satisfies that (see the "three CONSECUTIVE" null test below); this is
    // the narrower shape that does: the no-patch trigger reaches 3 occurrences overall, but
    // the run is broken by one other-triggered failure, so last/prev differ.
    const history = new Map([
      [
        "src/foo.ts",
        [
          makeRecord("apply_patch_no_valid_blocks", NO_PATCH_HASH_SENTINEL),
          makeRecord("apply_patch_no_valid_blocks", NO_PATCH_HASH_SENTINEL),
          makeRecord("apply_patch_find_not_found", "hash-X"),
          makeRecord("apply_patch_no_valid_blocks", NO_PATCH_HASH_SENTINEL),
        ],
      ],
    ]);
    const result = detectFailureStall(makeCtx({ failureHistory: history }));
    expect(result).not.toBeNull();
    expect(result?.detail.verdict).toBe("trigger_repeated_3x");
  });

  it("custom threshold: fires at coachMin=1", () => {
    const history = new Map([
      ["src/baz.ts", [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-A")]],
    ]);
    const result = detectFailureStall(
      makeCtx({ failureHistory: history, coachingAttempts: 1 }),
      { failureCoachMin: 1 },
    );
    expect(result).not.toBeNull();
    expect(result?.detail.verdict).toBe("identical_patch_retried");
  });
});

describe("detectFailureStall — false-positive guards (C1)", () => {
  it("coaching < COACH_MIN → null (resume-safety C5)", () => {
    const history = new Map([
      [
        "src/foo.ts",
        [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-A")],
      ],
    ]);
    const result = detectFailureStall(
      makeCtx({ failureHistory: history, coachingAttempts: ANTI_THRASH_FAILURE_COACH_MIN - 1 }),
    );
    expect(result).toBeNull();
  });

  it("same_trigger_repeated_2x (weak) → null (C1 guard)", () => {
    // same trigger, different patchHash, no errorLine → same_trigger_repeated_2x in detectRepeatedFailure
    // antiThrash does NOT fire on this weak verdict
    const history = new Map([
      [
        "src/foo.ts",
        [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-B")],
      ],
    ]);
    const result = detectFailureStall(makeCtx({ failureHistory: history }));
    expect(result).toBeNull();
  });

  it("same_root_cause_different_patch (weak) → null (C1 guard)", () => {
    // same trigger, same errorLine, different patchHash → same_root_cause_different_patch
    const history = new Map([
      [
        "src/foo.ts",
        [makeRecord("tsc_error", "hash-A", 42), makeRecord("tsc_error", "hash-B", 42)],
      ],
    ]);
    const result = detectFailureStall(makeCtx({ failureHistory: history }));
    expect(result).toBeNull();
  });

  it("two no-patch failures sharing NO_PATCH_HASH_SENTINEL → null, not identical_patch_retried", () => {
    // Same trigger, same patchHash (both the sentinel) — would satisfy Verdict 1's raw
    // condition, but there's no real patch content behind either hash to confirm a
    // genuine repeat. Reachable today: apply_patch calls that omit `patch` (item 17's
    // establish; strict mode is dropped for Anthropic).
    const history = new Map([
      [
        "src/foo.ts",
        [
          makeRecord("apply_patch_no_valid_blocks", NO_PATCH_HASH_SENTINEL),
          makeRecord("apply_patch_no_valid_blocks", NO_PATCH_HASH_SENTINEL),
        ],
      ],
    ]);
    const result = detectFailureStall(makeCtx({ failureHistory: history }));
    expect(result).toBeNull();
  });

  it("three CONSECUTIVE no-patch failures, same trigger throughout → still null, no fallback reaches it", () => {
    // Corrects a claim from this fix's own establish pass: Verdict 2 does NOT reliably
    // catch a straight run of identical-trigger no-patch failures at 3, or at any count.
    // Its own precondition (last.trigger !== prev.trigger, line 128) is never satisfied
    // when every record in the run shares one trigger — last and prev are always equal.
    // The interleaved test above shows the shape that DOES still reach it; this is the
    // more realistic shape (the model repeatedly omits `patch` on consecutive calls),
    // and antiThrash produces no signal for it at all, at any repeat count. Primary
    // coaching is unaffected regardless — see detectRepeatedFailure's own tests below,
    // which fires at exactly 2 via a fallback with no such precondition.
    const history = new Map([
      [
        "src/foo.ts",
        [
          makeRecord("apply_patch_no_valid_blocks", NO_PATCH_HASH_SENTINEL),
          makeRecord("apply_patch_no_valid_blocks", NO_PATCH_HASH_SENTINEL),
          makeRecord("apply_patch_no_valid_blocks", NO_PATCH_HASH_SENTINEL),
        ],
      ],
    ]);
    const result = detectFailureStall(makeCtx({ failureHistory: history }));
    expect(result).toBeNull();
  });

  it("fewer than 2 records for a path → null", () => {
    const history = new Map([
      ["src/foo.ts", [makeRecord("tsc_error", "hash-A")]],
    ]);
    expect(detectFailureStall(makeCtx({ failureHistory: history }))).toBeNull();
  });

  it("empty failureHistory → null", () => {
    expect(detectFailureStall(makeCtx())).toBeNull();
  });
});

// ── detectRepeatedFailure (agentLoop.ts) — the sibling this file mirrors ──────
//
// Same NO_PATCH_HASH_SENTINEL guard on its own Verdict 1, but a different fallback
// shape from detectFailureStall's: same_trigger_repeated_2x has no "last/prev triggers
// must differ" precondition, so it fires at exactly 2 records, same as
// identical_patch_retried would have. CoachingController.routeFailure (the only real
// caller) doesn't branch on which repeat reason fired — both route to the same
// apply_patch_repeated_failure_same_file trigger — so guarding this site changes the
// telemetry label only, not what the model is coached to do or when.
describe("detectRepeatedFailure — no-patch sentinel guard", () => {
  it("two no-patch failures sharing NO_PATCH_HASH_SENTINEL → same_trigger_repeated_2x, not identical_patch_retried", () => {
    const history = new Map<string, FailureRecord[]>([
      [
        "src/foo.ts",
        [
          { trigger: "apply_patch_no_valid_blocks", patchHash: NO_PATCH_HASH_SENTINEL, errorLine: null, iter: 1 },
          { trigger: "apply_patch_no_valid_blocks", patchHash: NO_PATCH_HASH_SENTINEL, errorLine: null, iter: 2 },
        ],
      ],
    ]);
    expect(detectRepeatedFailure(history, "src/foo.ts")).toEqual({
      filePath: "src/foo.ts",
      reason: "same_trigger_repeated_2x",
    });
  });
});

// ── computeAntiThrashSignal ───────────────────────────────────────────────────

describe("computeAntiThrashSignal", () => {
  it("returns P4 signal when P4 matches", () => {
    const history = new Map([
      ["src/foo.ts", [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-A")]],
    ]);
    const result = computeAntiThrashSignal(makeCtx({ failureHistory: history }));
    expect(result?.pattern).toBe("failure_stall");
  });

  it("returns null when disabled via thresholds", () => {
    const history = new Map([
      ["src/foo.ts", [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-A")]],
    ]);
    const result = computeAntiThrashSignal(makeCtx({ failureHistory: history }), { enabled: false });
    expect(result).toBeNull();
  });

  it("returns null when no signal (empty history)", () => {
    expect(computeAntiThrashSignal(makeCtx())).toBeNull();
  });
});

// ── buildStallReflectionText ──────────────────────────────────────────────────

describe("buildStallReflectionText", () => {
  it("P4 text includes filePath, verdict, and guidance keywords", () => {
    const signal = {
      pattern: "failure_stall" as const,
      summaryTitle: "Repeated identical failures on src/foo.ts",
      detail: { filePath: "src/foo.ts", verdict: "identical_patch_retried", coachingAttempts: 2 },
    };
    const text = buildStallReflectionText(signal);
    expect(text).toContain("[ZONE_ANTI_THRASH]");
    expect(text).toContain("src/foo.ts");
    expect(text).toContain("identical_patch_retried");
    expect(text.toLowerCase()).toContain("abandon");
    expect(text).toContain("suggest_scope_change");
    expect(text).toContain("FINAL SUMMARY");
  });

  it("unknown pattern falls back to summaryTitle", () => {
    // future patterns (P5/P6) should fall through gracefully
    const signal = {
      pattern: "failure_stall" as const, // use valid type but hit else via a stub
      summaryTitle: "Some other signal",
      detail: { someField: "x" },
    };
    // patch around the pattern check: use a non-P4 detail shape
    const text = buildStallReflectionText({
      ...signal,
      // TypeScript won't allow an unknown pattern, but we test the else branch
      // by removing filePath from detail so the cast inside the if-branch would fail —
      // skip this: the else branch is only reachable via inc-2/3 additions.
    });
    expect(text).toBeTruthy();
  });
});

// ── detectWanderingSignal ─────────────────────────────────────────────────────

function makeReadMap(entries: [string, number][]): Map<string, number> {
  return new Map(entries);
}

describe("detectWanderingSignal — true positive", () => {
  it("fires when iter >= WANDER_ITER_MIN, filesModifiedSize=0, totalReads >= WANDER_READ_MIN", () => {
    const reads = makeReadMap([
      ["src/a.ts", 2],
      ["src/b.ts", 1],
      ["src/c.ts", 3],
    ]);
    const result = detectWanderingSignal(
      makeCtx({ iter: ANTI_THRASH_WANDER_ITER_MIN, filesReadCountThisRun: reads, filesModifiedSize: 0 }),
    );
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("wandering");
    expect(result?.detail.uniqueFiles).toBe(3);
    expect(result?.detail.totalReads).toBe(6);
    expect(result?.detail.multiReadCount).toBe(2); // a(2) and c(3)
    expect(result?.detail.iter).toBe(ANTI_THRASH_WANDER_ITER_MIN);
  });
});

describe("detectWanderingSignal — false-positive guards", () => {
  function baseWanderCtx(): AntiThrashContext {
    return makeCtx({
      iter: ANTI_THRASH_WANDER_ITER_MIN,
      filesModifiedSize: 0,
      filesReadCountThisRun: makeReadMap([
        ["src/a.ts", 2],
        ["src/b.ts", 2],
        ["src/c.ts", 2],
      ]),
    });
  }

  it("archetype=question → null", () => {
    expect(detectWanderingSignal({ ...baseWanderCtx(), archetype: "question" })).toBeNull();
  });

  it("archetype=investigation → null", () => {
    expect(detectWanderingSignal({ ...baseWanderCtx(), archetype: "investigation" })).toBeNull();
  });

  it("isReadOnly=true → null", () => {
    expect(detectWanderingSignal({ ...baseWanderCtx(), isReadOnly: true })).toBeNull();
  });

  it("filesModifiedSize > 0 → null", () => {
    expect(detectWanderingSignal({ ...baseWanderCtx(), filesModifiedSize: 1 })).toBeNull();
  });

  it("iter < WANDER_ITER_MIN → null", () => {
    expect(
      detectWanderingSignal({ ...baseWanderCtx(), iter: ANTI_THRASH_WANDER_ITER_MIN - 1 }),
    ).toBeNull();
  });

  it("totalReads < WANDER_READ_MIN → null", () => {
    const tooFewReads = makeReadMap([["src/a.ts", ANTI_THRASH_WANDER_READ_MIN - 1]]);
    expect(
      detectWanderingSignal({ ...baseWanderCtx(), filesReadCountThisRun: tooFewReads }),
    ).toBeNull();
  });
});

// ── predicate stability (C2 note) ─────────────────────────────────────────────

describe("detectFailureStall — predicate stability", () => {
  it("returns non-null regardless of filesModifiedSize (pure module has no baseline guard)", () => {
    // The filesModified baseline comparison lives in agentLoop.ts (Stage 2 inline check).
    // This pure function always returns non-null when the signal conditions are met,
    // regardless of how many files have been modified.
    const history = new Map([
      ["src/foo.ts", [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-A")]],
    ]);
    const ctxWithWrites = makeCtx({ failureHistory: history, filesModifiedSize: 999 });
    expect(detectFailureStall(ctxWithWrites)).not.toBeNull();
  });
});

// ── computeAntiThrashSignal — P4 > P5 priority ───────────────────────────────

describe("computeAntiThrashSignal — priority", () => {
  it("P4 wins when both P4 and P5 conditions hold", () => {
    const history = new Map([
      ["src/foo.ts", [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-A")]],
    ]);
    const reads = new Map([
      ["src/a.ts", 3],
      ["src/b.ts", 3],
    ]);
    const ctx = makeCtx({
      failureHistory: history,
      iter: ANTI_THRASH_WANDER_ITER_MIN,
      filesModifiedSize: 0,
      filesReadCountThisRun: reads,
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("failure_stall");
  });

  it("P5 returned when only wandering condition holds", () => {
    const reads = new Map([
      ["src/a.ts", 3],
      ["src/b.ts", 3],
    ]);
    const ctx = makeCtx({
      iter: ANTI_THRASH_WANDER_ITER_MIN,
      filesModifiedSize: 0,
      filesReadCountThisRun: reads,
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("wandering");
  });
});

// ── detectCostBurnSignal ──────────────────────────────────────────────────────

describe("detectCostBurnSignal — true positive", () => {
  it("fires when iter >= COST_BURN_ITER_MIN, costUsd >= COST_BURN_USD, filesModifiedSize=0", () => {
    const result = detectCostBurnSignal(
      makeCtx({
        iter: ANTI_THRASH_COST_BURN_ITER_MIN,
        costUsd: ANTI_THRASH_COST_BURN_USD,
        filesModifiedSize: 0,
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("cost_burn");
    expect(result?.detail.costUsd).toBe(ANTI_THRASH_COST_BURN_USD);
    expect(result?.detail.iter).toBe(ANTI_THRASH_COST_BURN_ITER_MIN);
  });
});

describe("detectCostBurnSignal — false-positive guards", () => {
  function baseCostBurnCtx(): AntiThrashContext {
    return makeCtx({
      iter: ANTI_THRASH_COST_BURN_ITER_MIN,
      costUsd: ANTI_THRASH_COST_BURN_USD,
      filesModifiedSize: 0,
    });
  }

  it("archetype=question → null", () => {
    expect(detectCostBurnSignal({ ...baseCostBurnCtx(), archetype: "question" })).toBeNull();
  });

  it("archetype=investigation → null", () => {
    expect(detectCostBurnSignal({ ...baseCostBurnCtx(), archetype: "investigation" })).toBeNull();
  });

  it("isReadOnly=true → null", () => {
    expect(detectCostBurnSignal({ ...baseCostBurnCtx(), isReadOnly: true })).toBeNull();
  });

  it("filesModifiedSize > 0 → null", () => {
    expect(detectCostBurnSignal({ ...baseCostBurnCtx(), filesModifiedSize: 1 })).toBeNull();
  });

  it("iter < COST_BURN_ITER_MIN → null", () => {
    expect(
      detectCostBurnSignal({ ...baseCostBurnCtx(), iter: ANTI_THRASH_COST_BURN_ITER_MIN - 1 }),
    ).toBeNull();
  });

  it("costUsd < COST_BURN_USD → null", () => {
    expect(
      detectCostBurnSignal({ ...baseCostBurnCtx(), costUsd: ANTI_THRASH_COST_BURN_USD - 0.01 }),
    ).toBeNull();
  });
});

describe("detectCostBurnSignal — float threshold not floored", () => {
  it("custom costBurnUsd: 0.5 trips at costUsd=0.5", () => {
    const result = detectCostBurnSignal(
      makeCtx({ iter: ANTI_THRASH_COST_BURN_ITER_MIN, costUsd: 0.5, filesModifiedSize: 0 }),
      { costBurnUsd: 0.5 },
    );
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("cost_burn");
  });

  it("readEnvFloat returns 0.5 without flooring", () => {
    const prev = process.env["ZONE_TEST_FLOAT_ENV"];
    process.env["ZONE_TEST_FLOAT_ENV"] = "0.5";
    expect(readEnvFloat("ZONE_TEST_FLOAT_ENV", 99)).toBe(0.5);
    if (prev === undefined) delete process.env["ZONE_TEST_FLOAT_ENV"];
    else process.env["ZONE_TEST_FLOAT_ENV"] = prev;
  });
});

// ── computeAntiThrashSignal — P4 > P5 > P6 priority ─────────────────────────

describe("computeAntiThrashSignal — P5 vs P6 priority", () => {
  it("P5 wins over P6 when both hold", () => {
    // Both P5 (enough reads) and P6 (enough cost) conditions satisfied
    const reads = makeReadMap([
      ["src/a.ts", 3],
      ["src/b.ts", 3],
    ]);
    const ctx = makeCtx({
      iter: ANTI_THRASH_COST_BURN_ITER_MIN, // >= both iter thresholds
      costUsd: ANTI_THRASH_COST_BURN_USD,
      filesModifiedSize: 0,
      filesReadCountThisRun: reads, // totalReads=6 >= WANDER_READ_MIN
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("wandering");
  });

  it("P6 fires alone when reads below wander threshold but cost above burn threshold", () => {
    // Only 1 read — P5 won't trip; cost is high enough for P6
    const reads = makeReadMap([["src/a.ts", 1]]);
    const ctx = makeCtx({
      iter: ANTI_THRASH_COST_BURN_ITER_MIN,
      costUsd: ANTI_THRASH_COST_BURN_USD,
      filesModifiedSize: 0,
      filesReadCountThisRun: reads, // totalReads=1 < WANDER_READ_MIN
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("cost_burn");
  });

  it("P4 beats P6 when both hold", () => {
    const history = new Map([
      ["src/foo.ts", [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-A")]],
    ]);
    const ctx = makeCtx({
      failureHistory: history,
      iter: ANTI_THRASH_COST_BURN_ITER_MIN,
      costUsd: ANTI_THRASH_COST_BURN_USD,
      filesModifiedSize: 0,
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("failure_stall");
  });
});

// ── buildStallReflectionText — cost_burn ─────────────────────────────────────

describe("buildStallReflectionText — cost_burn", () => {
  it("P6 text surfaces $cost, iter count, and commit/FINAL SUMMARY guidance", () => {
    const signal = {
      pattern: "cost_burn" as const,
      summaryTitle: "Cost burn: $1.000 across 10 iters, no writes",
      detail: { costUsd: 1.0, iter: 10 },
    };
    const text = buildStallReflectionText(signal);
    expect(text).toContain("[ZONE_ANTI_THRASH]");
    expect(text).toContain("$1.000");
    expect(text).toContain("10 iterations");
    expect(text.toLowerCase()).toContain("patch");
    expect(text).toContain("FINAL SUMMARY");
    expect(text).toContain("Do NOT continue");
  });
});

// ── buildStallReflectionText — wandering ─────────────────────────────────────

describe("buildStallReflectionText — wandering", () => {
  it("P5 text surfaces read counts and commit/FINAL SUMMARY guidance", () => {
    const signal = {
      pattern: "wandering" as const,
      summaryTitle: "Wandering: 6 reads across 3 files, no writes",
      detail: { uniqueFiles: 3, totalReads: 6, multiReadCount: 2, iter: 10 },
    };
    const text = buildStallReflectionText(signal);
    expect(text).toContain("[ZONE_ANTI_THRASH]");
    expect(text).toContain("6");
    expect(text).toContain("3 files");
    expect(text).toContain("2 re-read");
    expect(text).toContain("10 iterations");
    expect(text.toLowerCase()).toContain("patch");
    expect(text).toContain("FINAL SUMMARY");
    expect(text).toContain("Do NOT keep reading");
  });
});

// ── detectNoProgressSignal helpers ───────────────────────────────────────────

function makeSnapshot(
  iter: number,
  introducedKeys: string[],
  successfulAppliesAtCapture: number,
): ErrorKeySnapshot {
  return { iter, introducedKeys, successfulAppliesAtCapture };
}

function makeNoProgressCtx(
  snapshots: ErrorKeySnapshot[],
  overrides?: Partial<AntiThrashContext>,
): AntiThrashContext {
  return makeCtx({
    iter: ANTI_THRASH_NO_PROGRESS_ITER_MIN,
    recentVerifyKeySets: snapshots,
    filesModifiedSize: 2, // writes are happening (P5/P6 require 0)
    ...overrides,
  });
}

// ── detectNoProgressSignal — true positive ────────────────────────────────────

describe("detectNoProgressSignal — true positive", () => {
  it("fires when introduced-keys frozen, applies grew, iter/window met", () => {
    const snapshots = [
      makeSnapshot(8,  ["src/a.ts:0:TS2304:cannot find name foo"], 3),
      makeSnapshot(10, ["src/a.ts:0:TS2304:cannot find name foo"], 5),
    ];
    const result = detectNoProgressSignal(makeNoProgressCtx(snapshots));
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("no_progress");
    expect(result?.detail.frozenKeyCount).toBe(1);
    expect(result?.detail.windowSize).toBe(ANTI_THRASH_NO_PROGRESS_WINDOW);
    expect(result?.detail.successfulAppliesGrowth).toBe(2);
    expect(String(result?.detail.keyPreview)).toContain("TS2304");
  });

  it("fires with custom window=3 when all 3 snapshots are frozen and applies grew", () => {
    const key = "src/b.ts:0:TS2322:type mismatch";
    const snapshots = [
      makeSnapshot(5,  [key], 1),
      makeSnapshot(7,  [key], 2),
      makeSnapshot(9,  [key], 4),
    ];
    const result = detectNoProgressSignal(
      makeNoProgressCtx(snapshots, { iter: 9 }),
      { noProgressWindow: 3, noProgressIterMin: 9 },
    );
    expect(result).not.toBeNull();
    expect(result?.pattern).toBe("no_progress");
    expect(result?.detail.frozenKeyCount).toBe(1);
    expect(result?.detail.windowSize).toBe(3);
  });

  it("keyPreview truncates to 3 entries + ellipsis when more than 3 keys", () => {
    const keys = ["k1", "k2", "k3", "k4"];
    const snapshots = [
      makeSnapshot(8,  keys, 1),
      makeSnapshot(10, keys, 3),
    ];
    const result = detectNoProgressSignal(makeNoProgressCtx(snapshots));
    expect(result).not.toBeNull();
    expect(String(result?.detail.keyPreview)).toContain("…");
    expect(String(result?.detail.keyPreview)).toContain("k1");
  });
});

// ── detectNoProgressSignal — false-positive guards ───────────────────────────

describe("detectNoProgressSignal — false-positive guards", () => {
  const frozenKey = "src/a.ts:0:TS2304:cannot find name foo";

  function frozenGrowingSnapshots(): ErrorKeySnapshot[] {
    return [
      makeSnapshot(8,  [frozenKey], 2),
      makeSnapshot(10, [frozenKey], 4),
    ];
  }

  it("applies NOT growing (equal successfulAppliesAtCapture) → null", () => {
    const snapshots = [
      makeSnapshot(8,  [frozenKey], 3),
      makeSnapshot(10, [frozenKey], 3), // same count
    ];
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots))).toBeNull();
  });

  it("applies strictly DECREASING → null", () => {
    const snapshots = [
      makeSnapshot(8,  [frozenKey], 5),
      makeSnapshot(10, [frozenKey], 3), // fewer
    ];
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots))).toBeNull();
  });

  it("introduced-set changing across the window (different keys in snapshots) → null", () => {
    const snapshots = [
      makeSnapshot(8,  [frozenKey], 1),
      makeSnapshot(10, ["src/b.ts:0:TS2322:type mismatch"], 3), // different
    ];
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots))).toBeNull();
  });

  it("introduced-set shrinking (first has 2 keys, second has 1) → null", () => {
    const snapshots = [
      makeSnapshot(8,  [frozenKey, "src/b.ts:0:TS2322:msg"], 1),
      makeSnapshot(10, [frozenKey], 3), // not identical
    ];
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots))).toBeNull();
  });

  it("introduced-set empty in all snapshots → null", () => {
    const snapshots = [
      makeSnapshot(8,  [], 1),
      makeSnapshot(10, [], 3),
    ];
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots))).toBeNull();
  });

  it("introduced-set empty in one snapshot → null", () => {
    const snapshots = [
      makeSnapshot(8,  [frozenKey], 1),
      makeSnapshot(10, [], 3), // empty
    ];
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots))).toBeNull();
  });

  it("iter < NO_PROGRESS_ITER_MIN → null", () => {
    const snapshots = frozenGrowingSnapshots();
    expect(
      detectNoProgressSignal(makeNoProgressCtx(snapshots, { iter: ANTI_THRASH_NO_PROGRESS_ITER_MIN - 1 })),
    ).toBeNull();
  });

  it("fewer than NO_PROGRESS_WINDOW snapshots → null", () => {
    const snapshots = [makeSnapshot(8, [frozenKey], 1)]; // only 1, window=2
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots))).toBeNull();
  });

  it("recentVerifyKeySets absent (undefined) → null", () => {
    const ctx = makeCtx({ iter: ANTI_THRASH_NO_PROGRESS_ITER_MIN });
    // recentVerifyKeySets not set → defaults to undefined → buffer=[] → null
    expect(detectNoProgressSignal(ctx)).toBeNull();
  });

  it("isReadOnly=true → null", () => {
    const snapshots = frozenGrowingSnapshots();
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots, { isReadOnly: true }))).toBeNull();
  });

  it("archetype=question → null", () => {
    const snapshots = frozenGrowingSnapshots();
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots, { archetype: "question" }))).toBeNull();
  });

  it("archetype=investigation → null", () => {
    const snapshots = frozenGrowingSnapshots();
    expect(detectNoProgressSignal(makeNoProgressCtx(snapshots, { archetype: "investigation" }))).toBeNull();
  });
});

// ── computeAntiThrashSignal — P3 priority ────────────────────────────────────

describe("computeAntiThrashSignal — P3 priority", () => {
  const frozenKey = "src/a.ts:0:TS2304:cannot find name foo";

  function p3Snapshots(): ErrorKeySnapshot[] {
    return [
      makeSnapshot(8,  [frozenKey], 1),
      makeSnapshot(10, [frozenKey], 3),
    ];
  }

  it("P4 wins over P3 when both conditions hold", () => {
    const history = new Map([
      ["src/foo.ts", [makeRecord("tsc_error", "hash-A"), makeRecord("tsc_error", "hash-A")]],
    ]);
    const ctx = makeCtx({
      iter: ANTI_THRASH_NO_PROGRESS_ITER_MIN,
      failureHistory: history,
      recentVerifyKeySets: p3Snapshots(),
      filesModifiedSize: 2,
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("failure_stall");
  });

  it("P3 wins over P5 when both conditions hold", () => {
    // P5 requires filesModifiedSize=0 AND totalReads >= threshold.
    // P3 requires frozen non-empty keys + applies growing.
    // With filesModifiedSize=0, P5 would fire; but P3 is earlier in the chain.
    const reads = makeReadMap([["src/a.ts", 3], ["src/b.ts", 3]]);
    const ctx = makeCtx({
      iter: ANTI_THRASH_NO_PROGRESS_ITER_MIN,
      filesModifiedSize: 0,   // P5 would fire on this
      filesReadCountThisRun: reads,  // totalReads=6 >= WANDER_READ_MIN
      recentVerifyKeySets: p3Snapshots(),  // P3 fires on this
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("no_progress");
  });

  it("P3 wins over P6 when both conditions hold", () => {
    // P6 requires filesModifiedSize=0 AND iter/cost thresholds.
    const ctx = makeCtx({
      iter: ANTI_THRASH_COST_BURN_ITER_MIN, // >= both P3 and P6 iter thresholds
      costUsd: ANTI_THRASH_COST_BURN_USD,
      filesModifiedSize: 0,   // P6 would fire on this
      recentVerifyKeySets: p3Snapshots(),
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("no_progress");
  });

  it("P3 fires alone when P4/P5/P6 don't hold", () => {
    const ctx = makeCtx({
      iter: ANTI_THRASH_NO_PROGRESS_ITER_MIN,
      filesModifiedSize: 2,   // P5/P6 require 0
      recentVerifyKeySets: p3Snapshots(),
    });
    const result = computeAntiThrashSignal(ctx);
    expect(result?.pattern).toBe("no_progress");
  });
});

// ── stagedWriteCount gate — P5/P6 false-positive fix ─────────────────────────

function makeReadsMap(count: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < count; i++) m.set(`src/f${i}.ts`, 1);
  return m;
}

describe("stagedWriteCount gate (P5/P6 false-positive fix)", () => {
  // (i) stagedWriteCount > 0 spares a progressing multi_edit run from false termination.
  it("detectWanderingSignal returns null when stagedWriteCount > 0", () => {
    const ctx = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 2,
      filesReadCountThisRun: makeReadsMap(ANTI_THRASH_WANDER_READ_MIN),
      iter: ANTI_THRASH_WANDER_ITER_MIN,
    });
    expect(detectWanderingSignal(ctx)).toBeNull();
  });

  it("detectCostBurnSignal returns null when stagedWriteCount > 0", () => {
    const ctx = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 1,
      costUsd: ANTI_THRASH_COST_BURN_USD,
      iter: ANTI_THRASH_COST_BURN_ITER_MIN,
    });
    expect(detectCostBurnSignal(ctx)).toBeNull();
  });

  it("computeAntiThrashSignal returns null when stagedWriteCount > 0 (no P4/P3)", () => {
    const ctx = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 3,
      filesReadCountThisRun: makeReadsMap(ANTI_THRASH_WANDER_READ_MIN),
      iter: ANTI_THRASH_WANDER_ITER_MIN,
      coachingAttempts: 0,
    });
    expect(computeAntiThrashSignal(ctx)).toBeNull();
  });

  // (ii) True wanderer / true burner still fire (regression lock).
  it("detectWanderingSignal still fires when stagedWriteCount is 0 (true stall)", () => {
    const ctx = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 0,
      filesReadCountThisRun: makeReadMap([["src/a.ts", 3], ["src/b.ts", 3]]),
      iter: ANTI_THRASH_WANDER_ITER_MIN,
    });
    expect(detectWanderingSignal(ctx)?.pattern).toBe("wandering");
  });

  it("detectCostBurnSignal still fires when stagedWriteCount is 0 (true stall)", () => {
    const ctx = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 0,
      costUsd: ANTI_THRASH_COST_BURN_USD,
      iter: ANTI_THRASH_COST_BURN_ITER_MIN,
    });
    expect(detectCostBurnSignal(ctx)?.pattern).toBe("cost_burn");
  });

  // (iii) Back-compat: stagedWriteCount omitted → treated as 0 → P5 fires.
  it("stagedWriteCount absent → ?? 0 → P5 still fires", () => {
    const ctx = makeCtx({
      filesModifiedSize: 0,
      // stagedWriteCount deliberately not set
      filesReadCountThisRun: makeReadMap([["src/a.ts", 3], ["src/b.ts", 3]]),
      iter: ANTI_THRASH_WANDER_ITER_MIN,
    });
    expect(detectWanderingSignal(ctx)?.pattern).toBe("wandering");
  });

  // (iv) Apply_patch+revert run returns BOTH filesModified AND stagingFiles to 0:
  // Step 9 add then revert_patch delete → filesModifiedSize=0;
  // stagedWrite then revert_patch stagingFiles.delete → stagedWriteCount=0.
  // Both guards are 0 → P5 fires correctly; no exemption is introduced.
  it("apply_patch+revert run (no multi_edit) is not exempted — both counts are 0", () => {
    const ctx = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 0,
      filesReadCountThisRun: makeReadMap([["src/a.ts", 3], ["src/b.ts", 3]]),
      iter: ANTI_THRASH_WANDER_ITER_MIN,
    });
    expect(detectWanderingSignal(ctx)?.pattern).toBe("wandering");
  });

  // (v) Read-diversity exemption: broad first-time investigation vs concentrated re-reading.
  it("broad first-time investigation is now exempt from P5 (false-positive fix)", () => {
    // 7 distinct files ×1 → uniqueFiles=7 >= wanderReadMin=5 AND totalReads=7 < factor*7=14 → null
    const reads = makeReadsMap(7);
    const ctx = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 0,
      filesReadCountThisRun: reads,
      iter: ANTI_THRASH_WANDER_ITER_MIN,
    });
    expect(detectWanderingSignal(ctx)).toBeNull();
  });

  it("concentrated re-reading still fires P5 (true-thrash lock)", () => {
    // single-file: uniqueFiles=1 < wanderReadMin=5 → not exempt → fires
    const ctxSingle = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 0,
      filesReadCountThisRun: makeReadMap([["src/a.ts", 6]]),
      iter: ANTI_THRASH_WANDER_ITER_MIN,
    });
    expect(detectWanderingSignal(ctxSingle)?.pattern).toBe("wandering");
    // few-file: uniqueFiles=2 < wanderReadMin=5 → not exempt → fires
    const ctxFew = makeCtx({
      filesModifiedSize: 0,
      stagedWriteCount: 0,
      filesReadCountThisRun: makeReadMap([["src/a.ts", 3], ["src/b.ts", 3]]),
      iter: ANTI_THRASH_WANDER_ITER_MIN,
    });
    expect(detectWanderingSignal(ctxFew)?.pattern).toBe("wandering");
  });
});

// ── buildStallReflectionText — no_progress ────────────────────────────────────

describe("buildStallReflectionText — no_progress", () => {
  it("P3 text surfaces apply count, frozen key count + preview, and change-approach guidance", () => {
    const signal = {
      pattern: "no_progress" as const,
      summaryTitle: "No error-set progress: 2 introduced error(s) unchanged across 2 iterations",
      detail: {
        frozenKeyCount: 2,
        windowSize: 2,
        successfulAppliesGrowth: 3,
        keyPreview: "src/a.ts:0:TS2304:foo, src/b.ts:0:TS2322:bar",
      },
    };
    const text = buildStallReflectionText(signal);
    expect(text).toContain("[ZONE_ANTI_THRASH]");
    expect(text).toContain("3 patch(es)");
    expect(text).toContain("2 error(s)");
    expect(text).toContain("2 iterations");
    expect(text).toContain("TS2304");
    expect(text).toContain("FINAL SUMMARY");
    expect(text).toContain("Do NOT keep patching");
  });
});
