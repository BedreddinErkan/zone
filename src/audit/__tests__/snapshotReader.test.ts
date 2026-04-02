import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readAuditSnapshot } from "../snapshotReader.js";

const TEST_FILE = path.join(__dirname, "test-snapshot.json");

describe("readAuditSnapshot", () => {
  it("reads and parses a valid snapshot file", () => {
    const data = {
      snapshotId: "id-1",
      timestamp: "2026-04-02T00:00:00.000Z",
      input: { riskScore: 0.4, confidenceScore: 0.7, mode: "preview_only" },
      result: {
        mode: "preview_only",
        riskScore: 0.4,
        confidenceScore: 0.7,
        contradictionFlags: [],
      },
      contradictionFlags: [],
      reasonCodes: [],
      traceReasonMapping: [],
      parityValid: true,
    };

    fs.writeFileSync(TEST_FILE, JSON.stringify(data, null, 2));

    const result = readAuditSnapshot(TEST_FILE);

    expect(result).not.toBeNull();
    expect(result?.snapshotId).toBe("id-1");

    fs.unlinkSync(TEST_FILE);
  });

  it("returns null if file does not exist", () => {
    const result = readAuditSnapshot("non-existent-file.json");

    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(TEST_FILE, "{ invalid json");

    const result = readAuditSnapshot(TEST_FILE);

    expect(result).toBeNull();

    fs.unlinkSync(TEST_FILE);
  });
});