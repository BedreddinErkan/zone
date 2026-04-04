import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAuditSnapshot, resolveAuditOutFlag } from "../snapshotWriter.js";
import { buildAuditSnapshot } from "../auditSnapshot.js";
import type { AuditSnapshot } from "../auditSnapshot.js";
import type {
  DecisionEngineInput,
  DecisionEngineResult,
} from "../../engine/decisionEngine.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_TIMESTAMP = "2026-04-02T12:00:00.000Z";

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

function buildFixedSnapshot(
  inputOverrides: Partial<DecisionEngineInput> = {},
  resultOverrides: Partial<DecisionEngineResult> = {}
): AuditSnapshot {
  return buildAuditSnapshot(
    makeInput(inputOverrides),
    makeResult(resultOverrides),
    {
      timestamp: FIXED_TIMESTAMP,
      reasonCodes: ["SAFE_HIGH_CONFIDENCE"],
    }
  );
}

/** Creates a unique temp directory path for each test, cleaning up after. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "zone-audit-test-"));
}

// ---------------------------------------------------------------------------
// resolveAuditOutFlag
// ---------------------------------------------------------------------------

describe("resolveAuditOutFlag — flag parsing", () => {
  it("returns the path string when --audit-out=<path> is present", () => {
    const result = resolveAuditOutFlag(["--audit-out=output/audit.json"]);
    expect(result).toBe("output/audit.json");
  });

  it("returns null when --audit-out is absent from argv", () => {
    const result = resolveAuditOutFlag(["node", "zone", "--task", "do X"]);
    expect(result).toBeNull();
  });

  it("returns null for an empty argv array", () => {
    expect(resolveAuditOutFlag([])).toBeNull();
  });

  it("returns null when --audit-out= has no value (empty string after =)", () => {
    const result = resolveAuditOutFlag(["--audit-out="]);
    expect(result).toBeNull();
  });

  it("returns the path when the flag appears among many other flags", () => {
    const argv = [
      "node",
      "zone",
      "--task",
      "refactor service",
      "--audit",
      "--audit-out=reports/snap.json",
      "--format",
      "json",
    ];
    expect(resolveAuditOutFlag(argv)).toBe("reports/snap.json");
  });

  it("returns the first matching path when the flag appears multiple times", () => {
    const argv = ["--audit-out=first.json", "--audit-out=second.json"];
    expect(resolveAuditOutFlag(argv)).toBe("first.json");
  });

  it("returns null when only --audit (not --audit-out) is present", () => {
    expect(resolveAuditOutFlag(["--audit"])).toBeNull();
  });

  it("handles absolute paths correctly", () => {
    const result = resolveAuditOutFlag(["--audit-out=/tmp/audit/snapshot.json"]);
    expect(result).toBe("/tmp/audit/snapshot.json");
  });

  it("is case-sensitive — does not match --Audit-Out=<path>", () => {
    expect(resolveAuditOutFlag(["--Audit-Out=path.json"])).toBeNull();
  });

  it("returns null for partial prefix --audit-out (no = sign)", () => {
    // Space-separated form is not supported by resolveAuditOutFlag
    expect(resolveAuditOutFlag(["--audit-out", "path.json"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeAuditSnapshot — successful writes
// ---------------------------------------------------------------------------

describe("writeAuditSnapshot — file writing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the output file at the specified path", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("written file content is valid JSON (parseable without throwing)", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("written content matches JSON.stringify(snapshot, null, 2) exactly", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toBe(JSON.stringify(snapshot, null, 2));
  });

  it("written JSON contains the snapshotId field", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(parsed).toHaveProperty("snapshotId");
  });

  it("written JSON contains all 8 required snapshot fields", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(parsed).toHaveProperty("snapshotId");
    expect(parsed).toHaveProperty("timestamp");
    expect(parsed).toHaveProperty("input");
    expect(parsed).toHaveProperty("result");
    expect(parsed).toHaveProperty("contradictionFlags");
    expect(parsed).toHaveProperty("reasonCodes");
    expect(parsed).toHaveProperty("traceReasonMapping");
    expect(parsed).toHaveProperty("parityValid");
  });

  it("creates parent directories when they do not exist", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "nested", "deep", "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("creates parent directories three levels deep without error", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "a", "b", "c", "snap.json");
    writeAuditSnapshot(snapshot, filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("does not throw when parent directory already exists", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    // Parent dir already exists (tmpDir itself)
    expect(() => writeAuditSnapshot(snapshot, filePath)).not.toThrow();
  });

  it("returns undefined (void — no return value)", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    const returnVal = writeAuditSnapshot(snapshot, filePath);
    expect(returnVal).toBeUndefined();
  });

  it("snapshot object is not mutated by writeAuditSnapshot", () => {
    const snapshot = buildFixedSnapshot();
    const originalId = snapshot.snapshotId;
    const originalTimestamp = snapshot.timestamp;
    writeAuditSnapshot(snapshot, path.join(tmpDir, "audit.json"));
    expect(snapshot.snapshotId).toBe(originalId);
    expect(snapshot.timestamp).toBe(originalTimestamp);
  });

  it("preserves snapshotId in written JSON matching the original snapshot", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(parsed["snapshotId"]).toBe(snapshot.snapshotId);
  });

  it("preserves timestamp in written JSON matching the original snapshot", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    expect(parsed["timestamp"]).toBe(FIXED_TIMESTAMP);
  });

  it("written JSON is pretty-printed (contains newlines)", () => {
    const snapshot = buildFixedSnapshot();
    const filePath = path.join(tmpDir, "audit.json");
    writeAuditSnapshot(snapshot, filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    expect(raw).toContain("\n");
  });

  it("works correctly with a blocked-mode snapshot", () => {
    const snapshot = buildAuditSnapshot(
      makeInput({ riskScore: 0.9, confidenceScore: 0.7, mode: "blocked" }),
      makeResult({ riskScore: 0.9, confidenceScore: 0.7, mode: "blocked" }),
      { timestamp: FIXED_TIMESTAMP, reasonCodes: ["BLOCKED_HIGH_RISK_SCORE"] }
    );
    const filePath = path.join(tmpDir, "blocked-audit.json");
    writeAuditSnapshot(snapshot, filePath);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const result = parsed["result"] as Record<string, unknown>;
    expect(result["mode"]).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// writeAuditSnapshot — failure handling
// ---------------------------------------------------------------------------

describe("writeAuditSnapshot — failure handling (bad path / I/O error)", () => {
  it("does not throw when writeFileSync fails", () => {
    const snapshot = buildFixedSnapshot();
    const writeFileSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementationOnce(() => {
        throw new Error("ENOSPC: no space left on device");
      });

    expect(() => writeAuditSnapshot(snapshot, "/tmp/test-no-throw.json")).not.toThrow();
    writeFileSpy.mockRestore();
  });

  it("logs to stderr when writeFileSync fails", () => {
    const snapshot = buildFixedSnapshot();
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeFileSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementationOnce(() => {
        throw new Error("ENOSPC: no space left on device");
      });

    writeAuditSnapshot(snapshot, "/tmp/test-stderr.json");

    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("error log message contains '[audit] Failed to write snapshot:'", () => {
    const snapshot = buildFixedSnapshot();
    let capturedMessage = "";
    const stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation((msg: string) => {
        capturedMessage = msg;
      });
    const writeFileSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementationOnce(() => {
        throw new Error("disk is full");
      });

    writeAuditSnapshot(snapshot, "/tmp/test-msg.json");

    expect(capturedMessage).toContain("[audit] Failed to write snapshot:");
    stderrSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("error log message includes the original error text", () => {
    const snapshot = buildFixedSnapshot();
    let capturedMessage = "";
    const stderrSpy = vi
      .spyOn(console, "error")
      .mockImplementation((msg: string) => {
        capturedMessage = msg;
      });
    const writeFileSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementationOnce(() => {
        throw new Error("permission denied");
      });

    writeAuditSnapshot(snapshot, "/tmp/test-errmsg.json");

    expect(capturedMessage).toContain("permission denied");
    stderrSpy.mockRestore();
    writeFileSpy.mockRestore();
  });

  it("does not log to stdout (console.log) on success", () => {
    const tmpDir = makeTmpDir();
    const snapshot = buildFixedSnapshot();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    writeAuditSnapshot(snapshot, path.join(tmpDir, "audit.json"));

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not log to stdout (console.log) on failure", () => {
    const snapshot = buildFixedSnapshot();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeFileSpy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementationOnce(() => {
        throw new Error("error");
      });

    writeAuditSnapshot(snapshot, "/tmp/test-no-stdout.json");

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    writeFileSpy.mockRestore();
  });
});
