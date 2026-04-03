import { describe, expect, it } from "vitest";
import {
  buildAuditSnapshot,
  type AuditSnapshot,
  type TraceReasonEntry,
} from "../auditSnapshot.js";
import type {
  DecisionEngineInput,
  DecisionEngineResult,
} from "../../engine/decisionEngine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeInput(
  overrides: Partial<DecisionEngineInput> = {}
): DecisionEngineInput {
  return {
    riskScore: 0.2,
    confidenceScore: 0.9,
    mode: "safe_to_apply",
    ...overrides,
  };
}

function makeResult(
  overrides: Partial<DecisionEngineResult> = {}
): DecisionEngineResult {
  return {
    riskScore: 0.2,
    confidenceScore: 0.9,
    mode: "safe_to_apply",
    contradictionFlags: [],
    ...overrides,
  };
}

const FIXED_TIMESTAMP = "2026-04-02T12:00:00.000Z";

const SAMPLE_TRACE: TraceReasonEntry[] = [
  {
    code: "SAFE_HIGH_CONFIDENCE",
    severity: "low",
    category: "confidence",
    message: "Confidence score is strong enough to support safe auto-apply.",
  },
];

// ---------------------------------------------------------------------------
// Snapshot shape — all fields present
// ---------------------------------------------------------------------------

describe("buildAuditSnapshot — snapshot shape", () => {
  it("returns an object with a snapshotId field", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap).toHaveProperty("snapshotId");
  });

  it("returns an object with a timestamp field", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap).toHaveProperty("timestamp");
  });

  it("returns an object with an input field matching the provided input", () => {
    const input = makeInput();
    const snap = buildAuditSnapshot(input, makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap.input).toEqual(input);
  });

  it("returns an object with a result field matching the provided result", () => {
    const result = makeResult();
    const snap = buildAuditSnapshot(makeInput(), result, {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap.result).toEqual(result);
  });

  it("returns an object with a contradictionFlags field (array)", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(Array.isArray(snap.contradictionFlags)).toBe(true);
  });

  it("contradictionFlags mirrors result.contradictionFlags", () => {
    const flags = [
      {
        type: "LOW_CONFIDENCE_ON_SAFE" as const,
        severity: "warning" as const,
        message: "test flag",
      },
    ];
    const result = makeResult({ contradictionFlags: flags });
    const snap = buildAuditSnapshot(makeInput(), result, {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap.contradictionFlags).toEqual(flags);
  });

  it("returns an object with a reasonCodes field (array)", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(Array.isArray(snap.reasonCodes)).toBe(true);
  });

  it("reasonCodes reflects the options.reasonCodes passed in", () => {
    const codes = ["SAFE_HIGH_CONFIDENCE", "SAFE_LOW_RISK_LOCALIZED"];
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
      reasonCodes: codes,
    });
    expect(snap.reasonCodes).toEqual(codes);
  });

  it("returns an object with a traceReasonMapping field (array)", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(Array.isArray(snap.traceReasonMapping)).toBe(true);
  });

  it("traceReasonMapping reflects the options.traceReasonMapping passed in", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
      traceReasonMapping: SAMPLE_TRACE,
    });
    expect(snap.traceReasonMapping).toEqual(SAMPLE_TRACE);
  });

  it("each traceReasonEntry has code, severity, category, and message", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
      traceReasonMapping: SAMPLE_TRACE,
    });
    const entry = snap.traceReasonMapping[0];
    expect(entry).toHaveProperty("code");
    expect(entry).toHaveProperty("severity");
    expect(entry).toHaveProperty("category");
    expect(entry).toHaveProperty("message");
  });

  it("returns an object with a parityValid boolean field", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(typeof snap.parityValid).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// parityValid: true — clean/consistent inputs
// ---------------------------------------------------------------------------

describe("buildAuditSnapshot — parityValid: true on clean input", () => {
  it("returns parityValid: true when reasonCodes is empty", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
      reasonCodes: [],
    });
    expect(snap.parityValid).toBe(true);
  });

  it("returns parityValid: true for safe_to_apply mode with SAFE_ reason codes", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "safe_to_apply" }),
      makeResult({ mode: "safe_to_apply" }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
      }
    );
    expect(snap.parityValid).toBe(true);
  });

  it("returns parityValid: true for blocked mode with BLOCKED_ reason codes", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "blocked", riskScore: 0.9 }),
      makeResult({ mode: "blocked", riskScore: 0.9 }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"],
      }
    );
    expect(snap.parityValid).toBe(true);
  });

  it("returns parityValid: true for preview_only mode with PREVIEW_ reason codes", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "preview_only", riskScore: 0.4 }),
      makeResult({ mode: "preview_only", riskScore: 0.4 }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
      }
    );
    expect(snap.parityValid).toBe(true);
  });

  it("returns parityValid: true when at least one matching code is present alongside others", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "blocked", riskScore: 0.9 }),
      makeResult({ mode: "blocked", riskScore: 0.9 }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["BLOCKED_DESTRUCTIVE_OPERATION", "BLOCKED_HIGH_RISK_SCORE"],
      }
    );
    expect(snap.parityValid).toBe(true);
  });

  it("returns parityValid: true when no options are passed (default empty codes)", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult());
    expect(snap.parityValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parityValid: false — mismatched reason codes
// ---------------------------------------------------------------------------

describe("buildAuditSnapshot — parityValid: false on mismatched reasonCodes", () => {
  it("returns parityValid: false for safe_to_apply mode with BLOCKED_ codes", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "safe_to_apply" }),
      makeResult({ mode: "safe_to_apply" }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"],
      }
    );
    expect(snap.parityValid).toBe(false);
  });

  it("returns parityValid: false for blocked mode with SAFE_ codes", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "blocked", riskScore: 0.9 }),
      makeResult({ mode: "blocked", riskScore: 0.9 }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
      }
    );
    expect(snap.parityValid).toBe(false);
  });

  it("returns parityValid: false for preview_only mode with SAFE_ codes", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "preview_only", riskScore: 0.4 }),
      makeResult({ mode: "preview_only", riskScore: 0.4 }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["SAFE_LOW_RISK_LOCALIZED"],
      }
    );
    expect(snap.parityValid).toBe(false);
  });

  it("returns parityValid: false for blocked mode with PREVIEW_ codes", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "blocked", riskScore: 0.9 }),
      makeResult({ mode: "blocked", riskScore: 0.9 }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
      }
    );
    expect(snap.parityValid).toBe(false);
  });

  it("returns parityValid: false for safe_to_apply mode with all PREVIEW_ codes", () => {
    const snap = buildAuditSnapshot(
      makeInput({ mode: "safe_to_apply" }),
      makeResult({ mode: "safe_to_apply" }),
      {
        timestamp: FIXED_TIMESTAMP,
        reasonCodes: ["PREVIEW_MASS_SCOPE_CHANGE", "PREVIEW_LOW_CONFIDENCE"],
      }
    );
    expect(snap.parityValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Object.freeze
// ---------------------------------------------------------------------------

describe("buildAuditSnapshot — immutability", () => {
  it("returns a frozen object (Object.isFrozen === true)", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("does not throw when built but mutation attempt is silently ignored in non-strict mode", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    }) as Record<string, unknown>;
    // In strict mode this would throw; in non-strict mode it's a no-op.
    // Either way, the original value must be unchanged.
    const originalTimestamp = snap["timestamp"];
    try {
      snap["timestamp"] = "mutated";
    } catch {
      // strict mode — expected
    }
    expect(snap["timestamp"]).toBe(originalTimestamp);
  });
});

// ---------------------------------------------------------------------------
// snapshotId
// ---------------------------------------------------------------------------

describe("buildAuditSnapshot — snapshotId", () => {
  it("snapshotId is a non-empty string", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(typeof snap.snapshotId).toBe("string");
    expect(snap.snapshotId.length).toBeGreaterThan(0);
  });

  it("snapshotId contains only alphanumeric characters", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap.snapshotId).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("snapshotId is deterministic for the same input and timestamp", () => {
    const input = makeInput();
    const result = makeResult();
    const opts = { timestamp: FIXED_TIMESTAMP };
    const snap1 = buildAuditSnapshot(input, result, opts);
    const snap2 = buildAuditSnapshot(input, result, opts);
    expect(snap1.snapshotId).toBe(snap2.snapshotId);
  });

  it("snapshotId differs when riskScore changes", () => {
    const snap1 = buildAuditSnapshot(makeInput({ riskScore: 0.2 }), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    const snap2 = buildAuditSnapshot(makeInput({ riskScore: 0.8 }), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap1.snapshotId).not.toBe(snap2.snapshotId);
  });

  it("snapshotId differs when timestamp changes", () => {
    const input = makeInput();
    const result = makeResult();
    const snap1 = buildAuditSnapshot(input, result, {
      timestamp: "2026-04-02T12:00:00.000Z",
    });
    const snap2 = buildAuditSnapshot(input, result, {
      timestamp: "2026-04-02T13:00:00.000Z",
    });
    expect(snap1.snapshotId).not.toBe(snap2.snapshotId);
  });
});

// ---------------------------------------------------------------------------
// timestamp
// ---------------------------------------------------------------------------

describe("buildAuditSnapshot — timestamp", () => {
  it("timestamp is a valid ISO 8601 string when provided via options", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap.timestamp).toBe(FIXED_TIMESTAMP);
    expect(new Date(snap.timestamp).toISOString()).toBe(FIXED_TIMESTAMP);
  });

  it("timestamp defaults to a valid ISO 8601 string when not provided", () => {
    const before = Date.now();
    const snap = buildAuditSnapshot(makeInput(), makeResult());
    const after = Date.now();
    const ts = new Date(snap.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("timestamp matches the ISO 8601 pattern (YYYY-MM-DDTHH:mm:ss.sssZ)", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });
});

// ---------------------------------------------------------------------------
// Default / edge-case behaviour
// ---------------------------------------------------------------------------

describe("buildAuditSnapshot — defaults and edge cases", () => {
  it("reasonCodes defaults to an empty array when not provided", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap.reasonCodes).toEqual([]);
  });

  it("traceReasonMapping defaults to an empty array when not provided", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
    });
    expect(snap.traceReasonMapping).toEqual([]);
  });

  it("is serializable to JSON without loss of shape", () => {
    const snap = buildAuditSnapshot(makeInput(), makeResult(), {
      timestamp: FIXED_TIMESTAMP,
      reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
      traceReasonMapping: SAMPLE_TRACE,
    });
    const json = JSON.parse(JSON.stringify(snap)) as AuditSnapshot;
    expect(json.snapshotId).toBe(snap.snapshotId);
    expect(json.timestamp).toBe(snap.timestamp);
    expect(json.reasonCodes).toEqual(snap.reasonCodes);
    expect(json.parityValid).toBe(snap.parityValid);
  });

  it("snapshot with blocked mode and no flags produces a structurally complete object", () => {
    const input = makeInput({ riskScore: 0.85, confidenceScore: 0.7, mode: "blocked" });
    const result = makeResult({
      riskScore: 0.85,
      confidenceScore: 0.7,
      mode: "blocked",
      contradictionFlags: [],
    });
    const snap = buildAuditSnapshot(input, result, {
      timestamp: FIXED_TIMESTAMP,
      reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"],
    });
    expect(snap.snapshotId).toBeTruthy();
    expect(snap.result.mode).toBe("blocked");
    expect(snap.contradictionFlags).toEqual([]);
    expect(snap.parityValid).toBe(true);
  });

  it("snapshot with preview_only mode is structurally sound", () => {
    const input = makeInput({ riskScore: 0.45, confidenceScore: 0.6, mode: "preview_only" });
    const result = makeResult({
      riskScore: 0.45,
      confidenceScore: 0.6,
      mode: "preview_only",
    });
    const snap = buildAuditSnapshot(input, result, {
      timestamp: FIXED_TIMESTAMP,
      reasonCodes: ["PREVIEW_LOW_CONFIDENCE"],
    });
    expect(snap.result.mode).toBe("preview_only");
    expect(snap.parityValid).toBe(true);
    expect(Object.isFrozen(snap)).toBe(true);
  });
});
