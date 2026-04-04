import { beforeEach, describe, expect, it, vi } from "vitest";
import { printAuditSnapshot } from "../output.js";
import { resolveAuditFlag } from "../index.js";
import { buildAuditSnapshot } from "../../audit/auditSnapshot.js";
import type { AuditSnapshot } from "../../audit/auditSnapshot.js";
import type {
  DecisionEngineInput,
  DecisionEngineResult,
} from "../../engine/decisionEngine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TIMESTAMP = "2026-04-02T12:00:00.000Z";

function makeEngineInput(
  overrides: Partial<DecisionEngineInput> = {}
): DecisionEngineInput {
  return {
    riskScore: 0.2,
    confidenceScore: 0.9,
    mode: "safe_to_apply",
    ...overrides,
  };
}

function makeEngineResult(
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

function buildFixedSnapshot(
  inputOverrides: Partial<DecisionEngineInput> = {},
  resultOverrides: Partial<DecisionEngineResult> = {}
): AuditSnapshot {
  return buildAuditSnapshot(
    makeEngineInput(inputOverrides),
    makeEngineResult(resultOverrides),
    { timestamp: FIXED_TIMESTAMP }
  );
}

// ---------------------------------------------------------------------------
// printAuditSnapshot — outputs valid JSON
// ---------------------------------------------------------------------------

describe("printAuditSnapshot — JSON output", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("calls console.log exactly once with JSON when given a valid snapshot", () => {
    const snap = buildFixedSnapshot();
    printAuditSnapshot(snap);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("outputs a string that parses as valid JSON", () => {
    const snap = buildFixedSnapshot();
    printAuditSnapshot(snap);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("JSON output is pretty-printed (contains newlines)", () => {
    const snap = buildFixedSnapshot();
    printAuditSnapshot(snap);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    expect(raw).toContain("\n");
  });

  it("JSON output contains all 8 required snapshot fields", () => {
    const snap = buildFixedSnapshot();
    printAuditSnapshot(snap);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed).toHaveProperty("snapshotId");
    expect(parsed).toHaveProperty("timestamp");
    expect(parsed).toHaveProperty("input");
    expect(parsed).toHaveProperty("result");
    expect(parsed).toHaveProperty("contradictionFlags");
    expect(parsed).toHaveProperty("reasonCodes");
    expect(parsed).toHaveProperty("traceReasonMapping");
    expect(parsed).toHaveProperty("parityValid");
  });

  it("JSON.snapshotId is a non-empty string", () => {
    const snap = buildFixedSnapshot();
    printAuditSnapshot(snap);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(typeof parsed["snapshotId"]).toBe("string");
    expect((parsed["snapshotId"] as string).length).toBeGreaterThan(0);
  });

  it("JSON.timestamp matches the ISO 8601 fixed timestamp", () => {
    const snap = buildFixedSnapshot();
    printAuditSnapshot(snap);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(parsed["timestamp"]).toBe(FIXED_TIMESTAMP);
  });

  it("JSON.parityValid is a boolean", () => {
    const snap = buildFixedSnapshot();
    printAuditSnapshot(snap);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(typeof parsed["parityValid"]).toBe("boolean");
  });

  it("output is deterministic: same snapshot always produces identical JSON", () => {
    const snap = buildFixedSnapshot();
    printAuditSnapshot(snap);
    const first = logSpy.mock.calls[0]?.[0] as string;
    logSpy.mockClear();
    printAuditSnapshot(snap);
    const second = logSpy.mock.calls[0]?.[0] as string;
    expect(first).toBe(second);
  });

  it("two independently built snapshots with same input+timestamp produce identical JSON", () => {
    const snap1 = buildFixedSnapshot();
    const snap2 = buildFixedSnapshot();
    printAuditSnapshot(snap1);
    const json1 = logSpy.mock.calls[0]?.[0] as string;
    logSpy.mockClear();
    printAuditSnapshot(snap2);
    const json2 = logSpy.mock.calls[0]?.[0] as string;
    expect(json1).toBe(json2);
  });
});

// ---------------------------------------------------------------------------
// printAuditSnapshot — no-op on null / undefined
// ---------------------------------------------------------------------------

describe("printAuditSnapshot — no-op on falsy input", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("does not call console.log when snapshot is null", () => {
    printAuditSnapshot(null);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not call console.log when snapshot is undefined", () => {
    printAuditSnapshot(undefined);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("does not throw when called with null", () => {
    expect(() => printAuditSnapshot(null)).not.toThrow();
  });

  it("does not throw when called with undefined", () => {
    expect(() => printAuditSnapshot(undefined)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Snapshot is frozen before being passed to print
// ---------------------------------------------------------------------------

describe("printAuditSnapshot — snapshot immutability", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("snapshot returned by buildAuditSnapshot is frozen", () => {
    const snap = buildFixedSnapshot();
    expect(Object.isFrozen(snap)).toBe(true);
  });

  it("printAuditSnapshot accepts a frozen snapshot without error", () => {
    const snap = buildFixedSnapshot();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(() => printAuditSnapshot(snap)).not.toThrow();
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("snapshot fields remain unchanged after printAuditSnapshot is called", () => {
    const snap = buildFixedSnapshot();
    const originalTimestamp = snap.timestamp;
    const originalId = snap.snapshotId;
    printAuditSnapshot(snap);
    expect(snap.timestamp).toBe(originalTimestamp);
    expect(snap.snapshotId).toBe(originalId);
  });
});

// ---------------------------------------------------------------------------
// resolveAuditFlag — argv parsing
// ---------------------------------------------------------------------------

describe("resolveAuditFlag — --audit flag parsing from argv", () => {
  it("returns true when '--audit' is in argv", () => {
    expect(resolveAuditFlag(["node", "zone", "--task", "do X", "--audit"])).toBe(true);
  });

  it("returns true when '--audit' is the only extra flag", () => {
    expect(resolveAuditFlag(["--audit"])).toBe(true);
  });

  it("returns false when '--audit' is absent", () => {
    expect(resolveAuditFlag(["node", "zone", "--task", "do X"])).toBe(false);
  });

  it("returns false for an empty argv", () => {
    expect(resolveAuditFlag([])).toBe(false);
  });

  it("returns false for partial matches like '--auditing'", () => {
    expect(resolveAuditFlag(["--auditing"])).toBe(false);
  });

  it("returns false for '--Audit' (case-sensitive)", () => {
    expect(resolveAuditFlag(["--Audit"])).toBe(false);
  });

  it("returns true when '--audit' appears among many flags", () => {
    expect(
      resolveAuditFlag([
        "node",
        "zone",
        "--task",
        "refactor service",
        "--ci",
        "--verbose",
        "--audit",
        "--format",
        "json",
      ])
    ).toBe(true);
  });
});
