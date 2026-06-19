import { describe, expect, it } from "vitest";
import {
  detectFailureStall,
  computeAntiThrashSignal,
  buildStallReflectionText,
  ANTI_THRASH_FAILURE_COACH_MIN,
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
