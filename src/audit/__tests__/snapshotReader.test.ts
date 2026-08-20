import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAuditSnapshot } from "../snapshotReader.js";

/**
 * Writes go to a temp directory, not to `__dirname`. This file used to write
 * `test-snapshot.json` into its own — tracked — source directory and unlink it afterwards, with
 * the unlink outside any `finally`: a failing assertion between the two left the file behind
 * permanently, inside the repository. That is the same failure outcome as the staging fixture
 * that transiently created a real `src/a.ts` and broke a concurrent `tsc`, reached by a different
 * route. Nothing in the harness guards the repo tree — the home guard covers `~/.zone` only — so
 * the containment has to be the path itself.
 */
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zone-snapshot-reader-"));
const TEST_FILE = path.join(TMP_DIR, "test-snapshot.json");

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

it("writes outside the repository tree — the containment this file exists to keep", () => {
  expect(path.isAbsolute(TEST_FILE)).toBe(true);
  expect(TEST_FILE.startsWith(os.tmpdir())).toBe(true);
  expect(TEST_FILE).not.toContain(`${path.sep}src${path.sep}`);
});

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