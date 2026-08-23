import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Structural guard for the tool-call record seam.
 *
 * Behavioural tests structurally cannot see a NEW tool-call branch that forgets
 * to record: they exercise the branches that exist. This file enumerates the
 * sites instead, so adding a branch without a record fails here rather than
 * silently shipping a hole in the record.
 *
 * SELF-REFERENCE. This file necessarily contains the very tokens it counts, so
 * it must not be in its own scan set. That exclusion is asserted below rather
 * than left implicit: a later change to the scan glob that swept this file back
 * in would otherwise shift every constant here by a plausible-looking amount
 * and read as a real change. `markerAttribution.ts` handles the same hazard the
 * same way, and its own comment records that getting it wrong once moved a
 * count from 406 to 414 for reasons unrelated to the tree being measured.
 *
 * COUNTING BASIS: occurrences of the token, not lines containing it and not
 * call sites. The three agree today (16 + 1, one call per line); they diverge
 * the moment two calls share a line, so the basis is stated rather than assumed.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** The recorder module owns the only legitimate push onto the in-memory log. */
const RECORDER = "src/llm/toolCallRecord.ts";
/** This guard, excluded from its own scan — see SELF-REFERENCE above. */
const SELF = "src/llm/toolCallRecord.guard.test.ts";

const EXPECTED_RECORD_CALLS: Record<string, number> = {
  "src/llm/agentLoop.ts": 16,
  "src/llm/toolEventHandler/handleToolResult.ts": 1,
};
const EXPECTED_TOTAL_RECORD_CALLS = 17;

const PUSH_TOKEN = "toolCallLog.push(";

function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "src"], { cwd: REPO_ROOT, encoding: "utf8" });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".ts") || l.endsWith(".tsx"))
    .filter((l) => !/\.test\.tsx?$/.test(l))
    .filter((l) => !l.includes("__tests__/"));
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

function occurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

describe("tool-call record seam — structural guard", () => {
  it("PLAUSIBILITY FLOOR: the scan set is real (this is what makes the absence checks below non-vacuous)", () => {
    const files = trackedSources();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/llm/agentLoop.ts");
    expect(files).toContain(RECORDER);
    // A fact only a working scan can produce: agentLoop is a large file we can read.
    expect(read("src/llm/agentLoop.ts").length).toBeGreaterThan(100_000);
  });

  it("SELF-REFERENCE: this guard carries the tokens it counts, and is excluded from its own scan set", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, SELF))).toBe(true);
    // It contains the token — which is exactly why the exclusion matters...
    expect(occurrences(read(SELF), PUSH_TOKEN)).toBeGreaterThan(0);
    // ...and it is excluded.
    expect(trackedSources()).not.toContain(SELF);
  });

  it("no source file pushes to the tool-call log directly — every push goes through the recorder", () => {
    const offenders = trackedSources()
      .filter((f) => f !== RECORDER)
      .filter((f) => occurrences(read(f), PUSH_TOKEN) > 0);
    expect(offenders).toEqual([]);
  });

  it("the recorder is the sole pusher, and it does push", () => {
    expect(occurrences(read(RECORDER), "log.push(")).toBe(1);
  });

  it("recordToolCall is called at EXACTLY the known sites — equality, so a deleted site fails too", () => {
    for (const [file, expected] of Object.entries(EXPECTED_RECORD_CALLS)) {
      expect(occurrences(read(file), "recordToolCall(")).toBe(expected);
    }
    const total = trackedSources()
      .filter((f) => f !== RECORDER)
      .reduce((n, f) => n + occurrences(read(f), "recordToolCall("), 0);
    expect(total).toBe(EXPECTED_TOTAL_RECORD_CALLS);
  });

  it("there is exactly one production tool-execution site, paired with one result handler", () => {
    const files = trackedSources();
    const execSites = files.filter((f) => occurrences(read(f), "await executeTool(") > 0);
    const handlerSites = files.filter((f) => occurrences(read(f), "await handleToolResult(") > 0);
    expect(execSites).toEqual(["src/llm/agentLoop.ts"]);
    expect(handlerSites).toEqual(["src/llm/agentLoop.ts"]);
    expect(occurrences(read("src/llm/agentLoop.ts"), "await executeTool(")).toBe(1);
    expect(occurrences(read("src/llm/agentLoop.ts"), "await handleToolResult(")).toBe(1);
  });

  it("neither the recorder nor the sink reads an environment variable — recording cannot be gated", () => {
    expect(read(RECORDER)).not.toContain("process.env");
    expect(read("src/utils/toolCallSink.ts")).not.toContain("process.env");
  });
});
