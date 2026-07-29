import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { applyStdoutInterception } from "./stdoutShield.js";
import { _setMarkerSinkPathForTest } from "../../utils/markerSink.js";

/**
 * The shield's own swallow behavior is covered by stdoutShield.test.ts and is
 * unchanged here. These tests pin the one new thing: a marker that the shield
 * swallows from the console must still land in the sink, and a result line
 * (✓/✗/⚠) — swallowed too, but never a [zone-*] marker — must not.
 */

let testPath: string;
let originalWrite: typeof process.stdout.write;
let restore: (() => void) | null = null;

beforeEach(() => {
  testPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "zone-shield-sink-")), "markers.jsonl");
  _setMarkerSinkPathForTest(testPath);
  originalWrite = process.stdout.write.bind(process.stdout);
  delete process.env.ZONE_TUI_DEBUG;
});

afterEach(() => {
  restore?.();
  restore = null;
  process.stdout.write = originalWrite;
  delete process.env.ZONE_TUI_DEBUG;
  _setMarkerSinkPathForTest(null);
  vi.restoreAllMocks();
});

function readRecords(): Array<Record<string, unknown>> {
  if (!fs.existsSync(testPath)) return [];
  return fs
    .readFileSync(testPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("stdoutShield + markerSink integration", () => {
  it("a swallowed marker still lands in the sink", () => {
    const written: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    restore = applyStdoutInterception();

    process.stdout.write(`[zone-tier-grant-unusable] ${JSON.stringify({ tier: "complex" })}\n`);

    // Console output is still shielded — the existing behavior, unchanged.
    expect(written).toHaveLength(0);

    // And it now also reaches the sink.
    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("[zone-tier-grant-unusable]");
    expect(records[0]!.payload).toEqual({ tier: "complex" });
  });

  it("a ✓/✗ result line is swallowed but produces no sink record", () => {
    const written: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    restore = applyStdoutInterception();

    process.stdout.write("\n\x1b[32m✓\x1b[0m patching mode\n");

    expect(written).toHaveLength(0); // still swallowed, same as before
    expect(readRecords()).toHaveLength(0); // but never was a marker — no sink record
  });

  it("non-telemetry output is neither swallowed nor sunk", () => {
    const written: string[] = [];
    process.stdout.write = vi.fn((chunk: unknown) => {
      written.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    restore = applyStdoutInterception();

    process.stdout.write("regular output line\n");

    expect(written).toContain("regular output line\n");
    expect(readRecords()).toHaveLength(0);
  });
});
