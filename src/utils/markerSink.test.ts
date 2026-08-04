import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendMarkerRecord,
  _setMarkerSinkPathForTest,
  _resetMarkerSinkWarningsForTest,
  MARKER_SINK_MAX_BYTES,
} from "./markerSink.js";
import { withRequestContext } from "../llm/openaiContext.js";

/**
 * Three real marker shapes, measured from this codebase's own inventory —
 * not a dummy payload sized to make an assertion pass. Average 210 bytes/line.
 */
const REAL_MARKER_LINES = [
  `[zone-plan-empty-approval] ${JSON.stringify({ runId: "f9dae91e-ae23-478b-981d-249992aefe58", reasonField: "noChangeReason", reviewed: true })}`,
  `[zone-tier-grant-unusable] ${JSON.stringify({ runId: "f9dae91e-ae23-478b-981d-249992aefe58", tier: "complex", archetype: "investigation", grantedSubagentCalls: 4, toolSubsetSize: 5, removedBy: "capability_filter" })}`,
  `[zone-pricing] unknown model anthropic/claude-x, cost=0`,
];

let testPath: string;

function readRecords(): Array<Record<string, unknown>> {
  if (!fs.existsSync(testPath)) return [];
  return fs
    .readFileSync(testPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

beforeEach(() => {
  testPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zone-marker-sink-")), "markers.jsonl");
  _setMarkerSinkPathForTest(testPath);
});

afterEach(() => {
  _setMarkerSinkPathForTest(null);
  _resetMarkerSinkWarningsForTest();
  vi.restoreAllMocks();
});

const FILLER_TAG = "zone-filler";
const bigLine = (tag: string): string =>
  `[${tag}] ${JSON.stringify({ data: "x".repeat(2000) })}`;

/**
 * Fills the sink to just under MARKER_SINK_MAX_BYTES using byte-identical
 * filler lines (fixed content — no varying loop index in the payload, since
 * that would change each line's byte length as the index grows more digits
 * and break the exact-crossing guarantee below). Measures one real line's
 * on-disk delta empirically rather than estimating from the input string's
 * length (appendMarkerRecord re-serializes with an added `ts` field, so the
 * two differ). Works whether the file is empty or already has content
 * (e.g. a prior rotation's marker record) — tracks the delta, not the
 * absolute size after one append.
 */
function fillToJustUnderCap(): void {
  const sizeBefore = fs.existsSync(testPath) ? fs.statSync(testPath).size : 0;
  appendMarkerRecord(bigLine(FILLER_TAG));
  let currentSize = fs.statSync(testPath).size;
  const oneLineBytes = currentSize - sizeBefore;
  let guard = 0;
  while (currentSize + oneLineBytes <= MARKER_SINK_MAX_BYTES) {
    appendMarkerRecord(bigLine(FILLER_TAG));
    currentSize += oneLineBytes;
    guard += 1;
    if (guard > 2000) throw new Error("filler loop did not converge — cap math is wrong");
  }
  expect(fs.statSync(testPath).size).toBe(currentSize);
  expect(currentSize).toBeLessThan(MARKER_SINK_MAX_BYTES);
}

describe("appendMarkerRecord — basic shape", () => {
  it("records name, ISO ts, and JSON payload", () => {
    appendMarkerRecord(`[zone-tier-grant-unusable] ${JSON.stringify({ tier: "complex" })}`);
    const [record] = readRecords();
    expect(record!.name).toBe("[zone-tier-grant-unusable]");
    expect(record!.ts as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(record!.payload).toEqual({ tier: "complex" });
  });

  it("extracts runId from the payload when no ambient context is active", () => {
    appendMarkerRecord(`[zone-tier-grant-unusable] ${JSON.stringify({ runId: "run-abc", tier: "complex" })}`);
    const [record] = readRecords();
    expect(record!.runId).toBe("run-abc");
  });

  it("ambient getRequestContext().runId takes precedence over payload.runId", async () => {
    await withRequestContext({ runId: "ambient-run" }, async () => {
      appendMarkerRecord(`[zone-tier-grant-unusable] ${JSON.stringify({ runId: "payload-run", tier: "complex" })}`);
    });
    const [record] = readRecords();
    expect(record!.runId).toBe("ambient-run");
  });

  it("omits runId entirely when neither ambient nor payload carries one", () => {
    appendMarkerRecord(`[zone-pricing] unknown model anthropic/claude-x, cost=0`);
    const [record] = readRecords();
    expect(record).not.toHaveProperty("runId");
  });

  it("keeps a plain-text (non-JSON) trailer as a raw string payload", () => {
    appendMarkerRecord(`[zone-pricing] unknown model anthropic/claude-x, cost=0`);
    const [record] = readRecords();
    expect(record!.payload).toBe("unknown model anthropic/claude-x, cost=0");
  });

  it("does nothing for a line that is not a marker", () => {
    appendMarkerRecord("regular output line, not a marker at all\n");
    expect(fs.existsSync(testPath)).toBe(false);
  });
});

describe("bound — the current file stays near the cap, never grows past it unbounded", () => {
  it("stays within one record's overshoot of MARKER_SINK_MAX_BYTES across many forced rotations", () => {
    // Adapted from the old low-water-mark test: rotation has no packing
    // target to pin a band on, so this only asserts the property that
    // survives the redesign — the current file never accumulates past the
    // cap by more than one record, no matter how many rotations fire.
    for (let i = 0; i < 1700; i++) {
      appendMarkerRecord(bigLine(FILLER_TAG));
    }
    const finalSize = fs.statSync(testPath).size;
    expect(finalSize).toBeLessThan(MARKER_SINK_MAX_BYTES + 5000);
  });
});

describe("rotation — append-only, never rewrites in place", () => {
  it("does not rotate a file under the cap", () => {
    appendMarkerRecord(bigLine("zone-under-cap-1"));
    appendMarkerRecord(bigLine("zone-under-cap-2"));
    appendMarkerRecord(bigLine("zone-under-cap-3"));

    expect(fs.existsSync(testPath + ".1")).toBe(false);
    const records = readRecords();
    expect(records.length).toBe(3);
    expect(records.map((r) => r.name)).toEqual([
      "[zone-under-cap-1]",
      "[zone-under-cap-2]",
      "[zone-under-cap-3]",
    ]);
  });

  it("rotates when an append crosses the cap — the crossing record lands in .1, the next append starts the fresh file", () => {
    fillToJustUnderCap();

    // Per the real call order (append, then stat, then rotate-if-over), this
    // record is already written to the file that then gets renamed to .1.
    appendMarkerRecord(bigLine("zone-crossing-record"));

    expect(fs.existsSync(testPath + ".1")).toBe(true);
    const rotatedLines = fs
      .readFileSync(testPath + ".1", "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { name: string });
    expect(rotatedLines[rotatedLines.length - 1]!.name).toBe("[zone-crossing-record]");

    const current = readRecords();
    expect(current[0]!.name).toBe("[zone-marker-sink-rotated]");
    expect(current.some((r) => r.name === "[zone-crossing-record]")).toBe(false);
  });

  it("a second rotation overwrites .1 rather than accumulating", () => {
    fillToJustUnderCap();
    appendMarkerRecord(bigLine("zone-gen1-crossing"));
    expect(fs.readFileSync(testPath + ".1", "utf8")).toContain("zone-gen1-crossing");

    fillToJustUnderCap();
    appendMarkerRecord(bigLine("zone-gen2-crossing"));

    const secondGenRotated = fs.readFileSync(testPath + ".1", "utf8");
    expect(secondGenRotated).toContain("zone-gen2-crossing");
    expect(secondGenRotated).not.toContain("zone-gen1-crossing");
  });

  it("the rotation marker fires with priorSizeBytes and rotatedTo in its payload", () => {
    fillToJustUnderCap();
    appendMarkerRecord(bigLine("zone-marker-crossing"));

    const current = readRecords();
    const marker = current.find((r) => r.name === "[zone-marker-sink-rotated]");
    expect(marker).toBeDefined();
    const payload = marker!.payload as { priorSizeBytes: number; rotatedTo: string };
    expect(payload.priorSizeBytes).toBeGreaterThan(MARKER_SINK_MAX_BYTES);
    expect(payload.rotatedTo).toBe(testPath + ".1");
  });
});

describe("statSync/renameSync failures — warn once, never lose the record already appended", () => {
  it("a non-ENOENT statSync failure still appends the record, does not rotate, and warns once", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw err;
    });

    appendMarkerRecord(`[zone-tier-grant-unusable] ${JSON.stringify({ tier: "complex" })}`);

    const records = readRecords();
    expect(records.length).toBe(1);
    expect(records[0]!.name).toBe("[zone-tier-grant-unusable]");
    expect(fs.existsSync(testPath + ".1")).toBe(false);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toContain("EACCES");
  });

  it("an ENOENT statSync failure does not warn — genuinely nothing to rotate", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = Object.assign(new Error("no such file"), { code: "ENOENT" });
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw err;
    });

    appendMarkerRecord(`[zone-tier-grant-unusable] ${JSON.stringify({ tier: "complex" })}`);

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("a renameSync failure at rotation time warns once and does not lose the crossing record", () => {
    fillToJustUnderCap();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const err = Object.assign(new Error("device busy"), { code: "EBUSY" });
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw err;
    });

    appendMarkerRecord(bigLine("zone-rename-fail-crossing"));

    expect(fs.existsSync(testPath + ".1")).toBe(false);
    const records = readRecords();
    expect(records.some((r) => r.name === "[zone-rename-fail-crossing]")).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toContain("EBUSY");
  });
});

describe("re-entrancy — never writes to stdout/stderr, even on I/O failure", () => {
  // Spying on process.stdout.write/process.stderr.write directly does not
  // work here: vitest intercepts console.log/warn/error itself (to route
  // them into its own reporter) before they would reach process.std*.write,
  // so a spy on the process-level methods never sees a console.* call made
  // during a test — confirmed empirically, not assumed. console.* is also
  // the more direct thing to assert on: log()/debugLog()/errorLog() are all
  // thin wrappers over console.log/console.error, so spying there catches
  // every one of the forbidden calls at the point they actually converge.
  it("returns normally and calls no console method when fs writes throw", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("simulated disk failure");
    });
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("simulated disk failure");
    });

    expect(() => appendMarkerRecord(`[zone-tier-grant-unusable] ${JSON.stringify({ tier: "complex" })}`)).not.toThrow();

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
