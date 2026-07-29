import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendMarkerRecord,
  _setMarkerSinkPathForTest,
  MARKER_SINK_MAX_BYTES,
  MARKER_SINK_TRIM_TARGET_BYTES,
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
  vi.restoreAllMocks();
});

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

describe("bound — ceiling under realistic marker sizes", () => {
  it("stays at or below MARKER_SINK_MAX_BYTES after writing well past it", () => {
    // ~210 bytes/line average; 512KB / 210 ~= 2,440 lines to reach the cap.
    // Write comfortably past that so multiple trims are exercised.
    for (let i = 0; i < 3000; i++) {
      appendMarkerRecord(REAL_MARKER_LINES[i % REAL_MARKER_LINES.length]!);
    }
    const finalSize = fs.statSync(testPath).size;
    expect(finalSize).toBeLessThanOrEqual(MARKER_SINK_MAX_BYTES);
    // Sanity: the file actually grew large enough to have exercised a trim,
    // not just stayed small the whole time.
    expect(finalSize).toBeGreaterThan(MARKER_SINK_TRIM_TARGET_BYTES / 4);
  });
});

describe("headroom — trim packs to the low-water mark, not the ceiling", () => {
  it("the running minimum size drops into the low-water band, not just under the ceiling", () => {
    // Large payloads so the line count involved stays in the low hundreds —
    // isolates the byte-target mechanism with nothing else able to interfere.
    //
    // Two designs were tried and rejected before this one, both instructive:
    //
    // 1. Fixed iteration count, check the final size. Rejected: a trim only
    //    fires every ~126 iterations at this line size (measured directly),
    //    so the file spends most of its time growing between trims — a fixed
    //    stopping point can land anywhere in that climb, independent of
    //    whether the low-water fix is even present.
    //
    // 2. Detect "size dropped versus the immediately preceding reading".
    //    Rejected: measured directly under the mutated (pack-to-ceiling)
    //    config, a trim there removes exactly one old line to compensate for
    //    the one just added, and that reaches an EXACT fixed point — post-
    //    trim size becomes bit-for-bit identical to the previous reading, so
    //    a strict "smaller than last time" check sees no decrease at all and
    //    never fires, independent of whether the mutation is present.
    //
    // What actually distinguishes the two configs cleanly: the correct
    // (low-water) trim drops ~126 lines at once, so its post-trim size is
    // far below the mutated config's, which only ever drops ~1 line and
    // stays within a few bytes of the cap. Tracking the minimum size seen
    // across enough iterations to guarantee at least one full cycle survives
    // both failure modes above — it doesn't need to catch a specific moment,
    // and it isn't fooled by a fixed point that never reads as a decrease.
    const bigLine = (i: number): string =>
      `[zone-headroom-test] ${JSON.stringify({ data: "x".repeat(2000), i })}`;
    // Measured directly: the first trigger fires around i=250 at this line
    // size. Tracking the minimum from i=0 would just record the file's own
    // starting size (one line, a couple KB) — trivially "low" for reasons
    // that have nothing to do with trimming. Skip past where a first trim
    // could plausibly have fired before tracking the minimum at all.
    const WARMUP_ITERATIONS = 1040;
    let minSize = Infinity;
    for (let i = 0; i < WARMUP_ITERATIONS + 600; i++) {
      appendMarkerRecord(bigLine(i));
      if (i >= WARMUP_ITERATIONS) minSize = Math.min(minSize, fs.statSync(testPath).size);
    }

    // Hardcoded expected range — NOT read back from MARKER_SINK_TRIM_TARGET_BYTES.
    // If the target is ever reverted to pack up to the cap instead of away from
    // it, the minimum never drops this low: mutation 4 covers exactly that.
    expect(minSize).toBeGreaterThan(800 * 1024);
    expect(minSize).toBeLessThanOrEqual(1200 * 1024);
  });
});

describe("a single oversized line does not wipe the sink", () => {
  it("retains the oversized record and drops earlier small ones instead of emptying the file", () => {
    appendMarkerRecord(`[zone-small-1] ${JSON.stringify({ n: 1 })}`);
    appendMarkerRecord(`[zone-small-2] ${JSON.stringify({ n: 2 })}`);
    appendMarkerRecord(`[zone-small-3] ${JSON.stringify({ n: 3 })}`);

    const oversizedPayload = "y".repeat(MARKER_SINK_MAX_BYTES + 10_000);
    appendMarkerRecord(`[zone-oversized] ${JSON.stringify({ data: oversizedPayload })}`);

    const records = readRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(records[records.length - 1]!.name).toBe("[zone-oversized]");
    expect(records.some((r) => r.name === "[zone-small-1]")).toBe(false);
    expect(records.some((r) => r.name === "[zone-small-2]")).toBe(false);
    expect(records.some((r) => r.name === "[zone-small-3]")).toBe(false);
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
