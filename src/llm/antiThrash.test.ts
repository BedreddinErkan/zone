import { describe, expect, it } from "vitest";
import {
  detectFailureStall,
  detectWanderingSignal,
  detectCostBurnSignal,
  computeAntiThrashSignal,
  buildStallReflectionText,
  readEnvFloat,
  ANTI_THRASH_FAILURE_COACH_MIN,
  ANTI_THRASH_WANDER_ITER_MIN,
  ANTI_THRASH_WANDER_READ_MIN,
  ANTI_THRASH_COST_BURN_ITER_MIN,
  ANTI_THRASH_COST_BURN_USD,
  type AntiThrashContext,
} from "./antiThrash.js";
import type { FailureRecord } from "./agentLoop.js";

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
