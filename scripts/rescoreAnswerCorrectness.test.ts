import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PINNED_MODEL,
  SHELL_TOOL,
  DIRECTIVE_FIX_CUTOVER_MS,
  loadPinnedCells,
  scoreCell,
  tally,
  clopperPearson,
  report,
  type Cell,
} from "./rescoreAnswerCorrectness.js";

/**
 * The claim this file exists to protect is a NEGATIVE one — that no T7 cell, in either phase,
 * names its ground-truth file — and a negative is exactly the shape that passes vacuously when
 * the harness silently reads nothing. So the fixture tests come first and each is built to fail
 * loudly if the loader stops finding cells, and the real-tree assertions carry their own
 * plausibility floor before any absence is asserted.
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const REAL_CAPTURES = path.join(REPO_ROOT, ".zone/audits/notice-regression-arm");

function writeCapture(
  dir: string,
  name: string,
  body: { model?: string; arm?: string; results: unknown[] }
): void {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body), "utf8");
}

function cell(over: Partial<Cell> = {}): Cell {
  return {
    taskId: "T1",
    timestampMs: 0,
    shellCalls: 1,
    correctFile: "src/a/b.ts",
    answer: "the answer names src/a/b.ts here",
    costUsd: 0,
    sourceFile: "f.json",
    ...over,
  };
}

describe("loadPinnedCells — cells are found by field, never by filename", () => {
  it("selects on the model and arm fields, so a differently-named capture is still found", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescore-"));
    // Deliberately named nothing like armB-T7-*: the real multi-task capture that the filename
    // filter missed has exactly this shape (many results, one file).
    writeCapture(dir, "armB-T2_T3-123.json", {
      model: PINNED_MODEL,
      arm: "B",
      results: [
        { id: "T2", correctFile: "x.ts", summary: "", toolCallLog: [] },
        { id: "T3", correctFile: null, summary: "", toolCallLog: [] },
      ],
    });
    expect(loadPinnedCells(dir).map((c) => c.taskId)).toEqual(["T2", "T3"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a non-pinned model even when the FILENAME says armB-T7 — the exact error this pass made", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescore-"));
    writeCapture(dir, "armB-T7-999.json", {
      model: "gpt-5.6-luna",
      arm: "B",
      results: [{ id: "T7", correctFile: "x.ts", summary: "", toolCallLog: [] }],
    });
    expect(loadPinnedCells(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("counts only the offered shell tool, not every tool call", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescore-"));
    writeCapture(dir, "c.json", {
      model: PINNED_MODEL,
      arm: "B",
      results: [
        {
          id: "T1",
          correctFile: "x.ts",
          summary: "",
          toolCallLog: [{ tool: "read_file" }, { tool: SHELL_TOOL }, { tool: "read_file" }],
        },
      ],
    });
    expect(loadPinnedCells(dir)[0]!.shellCalls).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("scoreCell — the three definitions are genuinely distinct", () => {
  it("SEARCHED counts a cell that issued one call and then declined", () => {
    // The registered boundary: the regression is ceasing to reach for the shell AT ALL, so one
    // reach refutes total suppression whatever the cell did next.
    expect(scoreCell(cell({ shellCalls: 1, answer: "no idea" })).searched).toBe(true);
    expect(scoreCell(cell({ shellCalls: 0 })).searched).toBe(false);
  });

  it("a cell that never searched cannot be CORRECT under either definition, even if the answer names the file", () => {
    const s = scoreCell(cell({ shellCalls: 0, answer: "src/a/b.ts" }));
    expect(s.searched).toBe(false);
    expect(s.correctBasename).toBe(false);
    expect(s.correctFullpath).toBe(false);
  });

  it("basename-only is its own class: CORRECT_BASENAME true, CORRECT_FULLPATH false", () => {
    const s = scoreCell(cell({ answer: "it lives in b.ts somewhere" }));
    expect(s.correctBasename).toBe(true);
    expect(s.correctFullpath).toBe(false);
    expect(s.basenameOnly).toBe(true);
  });

  it("a full-path citation satisfies both and is NOT flagged basename-only", () => {
    const s = scoreCell(cell({ answer: "see src/a/b.ts" }));
    expect(s.correctBasename).toBe(true);
    expect(s.correctFullpath).toBe(true);
    expect(s.basenameOnly).toBe(false);
  });

  it("null ground truth yields null, never false — and stays fully scoreable under SEARCHED", () => {
    const s = scoreCell(cell({ correctFile: null, shellCalls: 2 }));
    expect(s.scorability).toBe("unscoreable_no_ground_truth");
    expect(s.correctBasename).toBeNull();
    expect(s.correctFullpath).toBeNull();
    // The asymmetry the ledger registers: unscoreable belongs to the SECONDARY definitions only.
    expect(s.searched).toBe(true);
  });
});

describe("tally — unscoreable cells leave the denominator, they do not fail", () => {
  it("a null-ground-truth cell is counted by SEARCHED and excluded by CORRECT_*", () => {
    const cells = [
      scoreCell(cell({ taskId: "T3", correctFile: null, shellCalls: 1 })),
      scoreCell(cell({ taskId: "T4", answer: "see src/a/b.ts" })),
    ];
    expect(tally(cells, "SEARCHED")).toEqual({ k: 2, n: 2 });
    expect(tally(cells, "CORRECT_FULLPATH")).toEqual({ k: 1, n: 1 });
  });
});

describe("clopperPearson — agrees with an independent implementation", () => {
  // Cross-checked against a separate Python bisection over the same binomial tails; these four
  // are the populations the ledger reports, so a drift here changes committed prose.
  const cases: Array<[number, number, number, number]> = [
    [1, 1, 0.025, 1.0],
    [0, 5, 0.0, 0.522],
    [1, 3, 0.008, 0.906],
    [1, 8, 0.003, 0.527],
  ];
  for (const [k, n, lo, hi] of cases) {
    it(`${k}/${n} -> [${lo}, ${hi}]`, () => {
      const [a, b] = clopperPearson(k, n);
      expect(a).toBeCloseTo(lo, 3);
      expect(b).toBeCloseTo(hi, 3);
    });
  }

  it("a single success does NOT support a rate near 1 — the reading that made six cells look like six passes", () => {
    const [lo] = clopperPearson(1, 1);
    expect(lo).toBeLessThan(0.05);
  });
});

describe("against the real captures — plausibility floor before any absence claim", () => {
  const exists = fs.existsSync(REAL_CAPTURES);

  it.runIf(exists)("finds the pinned arm-B population: 14 cells across 7 tasks", () => {
    // The floor. Every negative claim below is meaningless if this number is 0, and a loader that
    // silently found nothing would make all of them pass.
    const cells = loadPinnedCells(REAL_CAPTURES);
    expect(cells.length).toBe(14);
    expect(new Set(cells.map((c) => c.taskId)).size).toBe(7);
  });

  it.runIf(exists)("reproduces item 90's 'one of eight' and item 157's 0/5 and 1/3 under SEARCHED", () => {
    const t7 = loadPinnedCells(REAL_CAPTURES).filter((c) => c.taskId === "T7").map(scoreCell);
    expect(t7.length).toBe(8);
    expect(tally(t7, "SEARCHED")).toEqual({ k: 1, n: 8 });
    const pre = t7.filter((c) => c.timestampMs < DIRECTIVE_FIX_CUTOVER_MS);
    const post = t7.filter((c) => c.timestampMs >= DIRECTIVE_FIX_CUTOVER_MS);
    expect(tally(pre, "SEARCHED")).toEqual({ k: 0, n: 5 });
    expect(tally(post, "SEARCHED")).toEqual({ k: 1, n: 3 });
  });

  it.runIf(exists)("the finding: T7 is 0/8 under BOTH correctness definitions — the post-fix signal is SEARCHED-only", () => {
    const t7 = loadPinnedCells(REAL_CAPTURES).filter((c) => c.taskId === "T7").map(scoreCell);
    expect(tally(t7, "CORRECT_BASENAME")).toEqual({ k: 0, n: 8 });
    expect(tally(t7, "CORRECT_FULLPATH")).toEqual({ k: 0, n: 8 });
    // And the one searching cell is precisely the one that is correct under neither.
    const searcher = t7.find((c) => c.searched)!;
    expect(searcher.correctBasename).toBe(false);
    expect(searcher.correctFullpath).toBe(false);
  });

  it.runIf(exists)("T1-T6 are one cell each, all pre-fix — six unmeasured tasks, not six clearing ones", () => {
    const cells = loadPinnedCells(REAL_CAPTURES).map(scoreCell);
    for (const t of ["T1", "T2", "T3", "T4", "T5", "T6"]) {
      const own = cells.filter((c) => c.taskId === t);
      expect(own.length, `${t} cell count`).toBe(1);
      expect(own[0]!.timestampMs, `${t} must be pre-fix`).toBeLessThan(DIRECTIVE_FIX_CUTOVER_MS);
    }
  });

  it.runIf(exists)("the ambiguity classes are exactly T2/T5 (basename-only) and T3 (unscoreable)", () => {
    const cells = loadPinnedCells(REAL_CAPTURES).map(scoreCell);
    const basenameOnly = [...new Set(cells.filter((c) => c.basenameOnly).map((c) => c.taskId))].sort();
    const unscoreable = [
      ...new Set(cells.filter((c) => c.scorability === "unscoreable_no_ground_truth").map((c) => c.taskId)),
    ].sort();
    expect(basenameOnly).toEqual(["T2", "T5"]);
    expect(unscoreable).toEqual(["T3"]);
  });

  it.runIf(exists)("report() renders all three definition names, so a bare k/n is never unattributed", () => {
    const text = report(REAL_CAPTURES);
    expect(text).toContain("SEARCHED");
    expect(text).toContain("CORRECT_BASENAME");
    expect(text).toContain("CORRECT_FULLPATH");
    expect(text).toContain("UNSCOREABLE");
  });
});
