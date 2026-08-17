import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  countBy,
  DEFAULT_RESULTS_PATH,
  hAny,
  hStrict,
  invokedDetectedRunnerBare,
  invokedDetectedRunnerLeadingToken,
  leadingBinaryTally,
  parseResults,
  reproductionRate,
  type ResultRecord,
} from "./item193Figures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function record(overrides: Partial<ResultRecord>): ResultRecord {
  return {
    arm: "control",
    fixture: "fx",
    ecosystem: "rust",
    detectedTestCommand: "cargo test",
    invokedTestCommands: ["cargo test"],
    invokedCommands: ["cargo test"],
    agreement: "agree",
    ...overrides,
  };
}

// ─── D1: hStrict vs hAny — a fixture that discriminates the two hypotheses ─────────────────────

describe("hStrict vs hAny — discrimination", () => {
  it("diverges when one of several invocations matches but not all (discriminates D1's two hypotheses)", () => {
    const r = record({
      detectedTestCommand: "cargo test",
      invokedTestCommands: ["cargo test", "cargo test --release"],
    });
    // Assert the two hypotheses actually differ on this fixture before trusting either value —
    // a fixture whose two sides coincide discriminates nothing (the eighth pattern).
    expect(hStrict(r)).not.toBe(hAny(r));
    expect(hStrict(r)).toBe(false); // not every invocation equals the detected command
    expect(hAny(r)).toBe(true); // but at least one does
  });

  it("agree when every invocation matches (both hypotheses collapse to the same value on this shape)", () => {
    const r = record({
      detectedTestCommand: "pytest",
      invokedTestCommands: ["pytest", "pytest"],
    });
    expect(hStrict(r)).toBe(true);
    expect(hAny(r)).toBe(true);
  });

  it("agree when no invocation matches (both false)", () => {
    const r = record({
      detectedTestCommand: "pytest",
      invokedTestCommands: ["pytest -q 2>&1 | tail -50"],
    });
    expect(hStrict(r)).toBe(false);
    expect(hAny(r)).toBe(false);
  });

  it("empty invokedTestCommands: deliberately false on both, not JS's vacuous every()=true / some()=false — pins the guard, does not discriminate by design", () => {
    const r = record({ invokedTestCommands: [] });
    // Not a discriminating fixture — the guard exists precisely so the two hypotheses do NOT
    // diverge on emptiness (neither reads as "agreement" when nothing was invoked at all).
    expect(hStrict(r)).toBe(false);
    expect(hAny(r)).toBe(false);
  });
});

describe("reproductionRate", () => {
  it("computes overall and per-arm match rate against the stored agreement field", () => {
    const records = [
      record({ arm: "control", agreement: "agree" }), // hAny(true) matches "agree"
      record({ arm: "control", agreement: "disagree", invokedTestCommands: ["other"] }), // hAny(false) matches "disagree"
      record({ arm: "rewrite", agreement: "agree", invokedTestCommands: ["other"] }), // hAny(false) MISMATCHES "agree"
    ];
    const result = reproductionRate(records, hAny);
    expect(result.matched).toBe(2);
    expect(result.total).toBe(3);
    expect(result.rate).toBe("2/3");
    expect(result.perArm).toEqual({
      control: { matched: 2, total: 2 },
      rewrite: { matched: 0, total: 1 },
    });
  });
});

// ─── D2: leading-token vs bare — a fixture that discriminates the two ──────────────────────────

describe("invokedDetectedRunnerLeadingToken vs invokedDetectedRunnerBare — discrimination", () => {
  it("diverges on a longer invocation that leads with the detected command (discriminates D2's two counts)", () => {
    const r = record({
      detectedTestCommand: "pytest",
      invokedTestCommands: ["pytest -q"],
    });
    expect(invokedDetectedRunnerLeadingToken(r)).not.toBe(invokedDetectedRunnerBare(r));
    expect(invokedDetectedRunnerLeadingToken(r)).toBe(true);
    expect(invokedDetectedRunnerBare(r)).toBe(false);
  });

  it("agree when the bare command is invoked exactly (both true)", () => {
    const r = record({ detectedTestCommand: "pytest", invokedTestCommands: ["pytest"] });
    expect(invokedDetectedRunnerLeadingToken(r)).toBe(true);
    expect(invokedDetectedRunnerBare(r)).toBe(true);
  });

  it("does not false-positive on a command that merely starts with the same characters but not the same token (e.g. 'pytest-cov' vs 'pytest')", () => {
    const r = record({ detectedTestCommand: "pytest", invokedTestCommands: ["pytest-cov -q"] });
    expect(invokedDetectedRunnerLeadingToken(r)).toBe(false);
    expect(invokedDetectedRunnerBare(r)).toBe(false);
  });
});

describe("countBy", () => {
  it("counts records matching a predicate", () => {
    const records = [record({ agreement: "agree" }), record({ agreement: "disagree" }), record({ agreement: "agree" })];
    expect(countBy(records, (r) => r.agreement === "agree")).toBe(2);
  });
});

// ─── D3: leadingBinaryTally — full-alphabet tally, no runner-name pattern ──────────────────────

describe("leadingBinaryTally", () => {
  it("tallies the first whitespace-delimited token of every invokedCommands entry", () => {
    const records = [
      record({ invokedCommands: ["cargo test", "cargo build"] }),
      record({ invokedCommands: ["pytest -q"] }),
    ];
    expect(leadingBinaryTally(records)).toEqual({ cargo: 2, pytest: 1 });
  });

  it("takes the leading token even when the command is pipe-wrapped, not a special case", () => {
    const records = [record({ invokedCommands: ["cargo test 2>&1 | tail -40"] })];
    expect(leadingBinaryTally(records)).toEqual({ cargo: 1 });
  });

  it("counts every entry across every record, not just distinct commands", () => {
    const records = [
      record({ invokedCommands: ["pytest -q", "pytest -q"] }),
      record({ invokedCommands: ["pytest"] }),
    ];
    const tally = leadingBinaryTally(records);
    expect(tally).toEqual({ pytest: 3 });
  });
});

// ─── parseResults — pure JSONL parsing ──────────────────────────────────────────────────────────

describe("parseResults", () => {
  it("parses one record per non-empty line, dropping a trailing newline's empty tail", () => {
    const raw = '{"arm":"control"}\n{"arm":"rewrite"}\n';
    const parsed = parseResults(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].arm).toBe("control");
    expect(parsed[1].arm).toBe("rewrite");
  });
});

// ─── Real-file regression: pins the DERIVED figures from docs/data/item193-results-v1.jsonl ────
// ─── (the committed, tracked copy — present on a fresh clone, unlike the gitignored source) ────
//
// These numbers were derived by running this module against the real file, THEN pinned here —
// not the reverse. See the ledger entry for the pre-registered predictions (from a prior,
// hand-derived recovery) compared against these derived values: all five agreed, with zero
// disagreement to report.

describe("real-file regression — docs/data/item193-results-v1.jsonl", () => {
  const raw = fs.readFileSync(DEFAULT_RESULTS_PATH, "utf8");
  const records = parseResults(raw);

  it("has exactly 40 records", () => {
    expect(records).toHaveLength(40);
  });

  it("D1: hAny reproduces the stored agreement field 40/40", () => {
    const result = reproductionRate(records, hAny);
    expect(result.rate).toBe("40/40");
    expect(result.perArm).toEqual({
      control: { matched: 20, total: 20 },
      rewrite: { matched: 20, total: 20 },
    });
  });

  it("D1: hStrict reproduces the stored agreement field 21/40", () => {
    const result = reproductionRate(records, hStrict);
    expect(result.rate).toBe("21/40");
    expect(result.perArm).toEqual({
      control: { matched: 10, total: 20 },
      rewrite: { matched: 11, total: 20 },
    });
  });

  it("D2: leading-token detected-runner invocation is 40/40", () => {
    expect(countBy(records, invokedDetectedRunnerLeadingToken)).toBe(40);
  });

  it("D2: bare detected-runner invocation is 38/40 — a different, smaller number than the leading-token count above", () => {
    expect(countBy(records, invokedDetectedRunnerBare)).toBe(38);
  });

  it("D3: the leading-binary alphabet is exactly {cargo: 24, pytest: 60, find: 1}, total 85", () => {
    const tally = leadingBinaryTally(records);
    expect(tally).toEqual({ cargo: 24, pytest: 60, find: 1 });
    const total = Object.values(tally).reduce((s, n) => s + n, 0);
    expect(total).toBe(85);
  });

  it("no record has an empty invokedTestCommands or invokedCommands array (the vacuous-case guard is untested by real data, by design)", () => {
    expect(records.every((r) => r.invokedTestCommands.length > 0)).toBe(true);
    expect(records.every((r) => r.invokedCommands.length > 0)).toBe(true);
  });
});

// ─── Committed-copy integrity: pinned by the copy's OWN hash, not by identity with the ──────────
// ─── gitignored .zone/ source, which may be regenerated, moved, or overwritten independently ───

describe("docs/data/item193-results-v1.jsonl — integrity", () => {
  it("matches the sha256 recorded at commit time", () => {
    const filePath = path.join(__dirname, "..", "docs", "data", "item193-results-v1.jsonl");
    const bytes = fs.readFileSync(filePath);
    const hash = createHash("sha256").update(bytes).digest("hex");
    // Pinned once, at commit time, against the committed artefact itself — this must change
    // only if the committed file is deliberately replaced, never as a side effect of anything
    // happening under the gitignored .zone/ tree.
    expect(hash).toBe("d7cbe1f8c12e2caff95fc19c30b9473279841a23d0063e269a549bb2101969f5");
  });
});
