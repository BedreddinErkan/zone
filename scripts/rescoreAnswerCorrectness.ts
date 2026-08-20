/**
 * Re-scores the notice-regression captures under three outcome definitions, one of which no
 * scoring function in this repository has ever computed.
 *
 * WHY THIS EXISTS. Every capture carries a `correctFile` field — the frozen ground truth for the
 * task — and `notice-regression-probe.mjs`'s scorer reads the shell-call list and nothing else.
 * Item 157 recorded in prose that its one searching cell "never named the component file this
 * task's frozen ground truth records as its correct one", and that observation never reached a
 * metric. The consequence is not cosmetic: that single cell is the entire numerator of both the
 * 1-of-8 and the 1-of-3 figures item 90 and item 157 turn on, so whether "clears" means SEARCHED
 * or SEARCHED-AND-CORRECT decides whether the post-fix signal exists at all.
 *
 * This is a re-scoring instrument over captures already on disk. It deliberately does NOT change
 * the live probe's billed path — item 90 warns that adding output paths to the instrument mid-arc
 * is how a measurement pass turns into a feature pass. Teaching the probe to emit these fields on
 * future runs is a separate, named step.
 *
 * THE THREE DEFINITIONS, named because a bare "0/3" is unreadable without knowing which:
 *
 *   SEARCHED               at least one run_command_readonly call was ISSUED.
 *   CORRECT_BASENAME       SEARCHED and the answer contains the ground-truth file's basename.
 *   CORRECT_FULLPATH       SEARCHED and the answer contains the full repo-relative path.
 *
 * SEARCHED is deliberate about its boundary, because the T7 cells sit nearest to it: a cell that
 * issues one call and then declines still counts as SEARCHED. The regression item 90 exists to
 * detect is the agent ceasing to reach for the shell AT ALL — arm B went to zero calls on every
 * task — so reaching once refutes total suppression. Whether the cell then gave up, or answered
 * the wrong question, is answer quality, which is exactly what the two CORRECT_* definitions
 * measure separately. Call success is not consulted either: a refused call is still a reach.
 *
 * CELLS ARE FOUND BY FIELD, NEVER BY FILENAME. Selecting captures by the `armB-T7-` filename
 * prefix simultaneously admits a `gpt-5.6-luna` cell (not the pinned model) and misses the pinned
 * T7 cell embedded in the multi-task `armB-T2_..._T7-*.json` capture — an error this pass made
 * and corrected. Filtering on the `model` and `arm` fields is what reconciles to item 90's own
 * "one of eight".
 */

import fs from "node:fs";
import path from "node:path";

/** Arms A, B and C were all measured on this model; anything else is a portability run. */
export const PINNED_MODEL = "claude-sonnet-4-6";

/** The shell tool this arm offers. `run_command` proper is withheld — that IS the regression. */
export const SHELL_TOOL = "run_command_readonly";

export type Scorability = "scoreable" | "unscoreable_no_ground_truth";

export interface Cell {
  taskId: string;
  timestampMs: number;
  shellCalls: number;
  correctFile: string | null;
  answer: string;
  costUsd: number;
  sourceFile: string;
}

export interface ScoredCell extends Cell {
  searched: boolean;
  correctBasename: boolean | null;
  correctFullpath: boolean | null;
  scorability: Scorability;
  /** True when the answer names the file but not its path — the one ambiguity class. */
  basenameOnly: boolean;
}

interface RawResult {
  id?: string;
  correctFile?: string | null;
  summary?: string;
  costUsd?: number;
  toolCallLog?: Array<{ tool?: string }>;
}

/**
 * Reads every capture in a directory and returns the pinned-model arm-B cells.
 * A capture may hold one result or many; both shapes are flattened the same way.
 */
export function loadPinnedCells(capturesDir: string): Cell[] {
  const cells: Cell[] = [];
  for (const file of fs.readdirSync(capturesDir)) {
    if (!file.endsWith(".json")) continue;
    let parsed: { model?: string; arm?: string; results?: RawResult[] };
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(capturesDir, file), "utf8"));
    } catch {
      continue; // a truncated capture is not this instrument's concern
    }
    if (parsed.model !== PINNED_MODEL || parsed.arm !== "B") continue;
    const stamp = /-(\d+)\.json$/.exec(file);
    for (const r of parsed.results ?? []) {
      if (typeof r.id !== "string") continue;
      cells.push({
        taskId: r.id,
        timestampMs: stamp ? Number(stamp[1]) : 0,
        shellCalls: (r.toolCallLog ?? []).filter((c) => c.tool === SHELL_TOOL).length,
        correctFile: r.correctFile ?? null,
        answer: String(r.summary ?? ""),
        costUsd: r.costUsd ?? 0,
        sourceFile: file,
      });
    }
  }
  return cells.sort((a, b) => a.taskId.localeCompare(b.taskId) || a.timestampMs - b.timestampMs);
}

/**
 * Scores one cell under all three definitions.
 *
 * The two CORRECT_* values are `null`, never `false`, when no ground truth exists — T3's
 * `correctFile` is null, and recording that as a failure would invent a result the capture cannot
 * support. Note the asymmetry this creates and which the caller must respect: an unscoreable cell
 * is still fully scoreable under SEARCHED, because searching needs no ground truth.
 */
export function scoreCell(cell: Cell): ScoredCell {
  const searched = cell.shellCalls > 0;
  if (cell.correctFile === null) {
    return {
      ...cell,
      searched,
      correctBasename: null,
      correctFullpath: null,
      scorability: "unscoreable_no_ground_truth",
      basenameOnly: false,
    };
  }
  const full = cell.answer.includes(cell.correctFile);
  const base = cell.answer.includes(path.basename(cell.correctFile));
  return {
    ...cell,
    searched,
    correctBasename: searched && base,
    correctFullpath: searched && full,
    scorability: "scoreable",
    basenameOnly: base && !full,
  };
}

export interface Tally {
  /** k of n, where n counts only cells the definition can score. */
  k: number;
  n: number;
}

export type Definition = "SEARCHED" | "CORRECT_BASENAME" | "CORRECT_FULLPATH";

/** Tallies one definition over a set of cells, skipping cells that definition cannot score. */
export function tally(cells: ScoredCell[], definition: Definition): Tally {
  if (definition === "SEARCHED") {
    return { k: cells.filter((c) => c.searched).length, n: cells.length };
  }
  const scoreable = cells.filter((c) => c.scorability === "scoreable");
  const field = definition === "CORRECT_BASENAME" ? "correctBasename" : "correctFullpath";
  return { k: scoreable.filter((c) => c[field] === true).length, n: scoreable.length };
}

/**
 * Exact Clopper-Pearson interval, by bisection on the binomial tail — no scipy, no normal
 * approximation. A bare k/n is not reportable for these populations: 1/1 carries a 95% interval
 * of [0.025, 1.000], and reporting it as "1.000" is what let six single-cell tasks read as six
 * clearing ones.
 */
export function clopperPearson(k: number, n: number, alpha = 0.05): [number, number] {
  if (n === 0) return [0, 1];
  const binom = (i: number, p: number): number => {
    let logC = 0;
    for (let j = 0; j < i; j++) logC += Math.log(n - j) - Math.log(j + 1);
    return Math.exp(logC + i * Math.log(p) + (n - i) * Math.log(1 - p));
  };
  const tailGe = (p: number): number => {
    if (p <= 0) return k === 0 ? 1 : 0;
    let s = 0;
    for (let i = k; i <= n; i++) s += binom(i, p);
    return s;
  };
  const tailLe = (p: number): number => {
    if (p >= 1) return k === n ? 1 : 0;
    let s = 0;
    for (let i = 0; i <= k; i++) s += binom(i, p);
    return s;
  };
  const bisect = (f: (p: number) => number, target: number, rising: boolean): number => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      const below = f(mid) < target;
      if (below === rising) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const lower = k === 0 ? 0 : bisect(tailGe, alpha / 2, true);
  const upper = k === n ? 1 : bisect(tailLe, alpha / 2, false);
  return [lower, upper];
}

function fmt(t: Tally): string {
  const [lo, hi] = clopperPearson(t.k, t.n);
  const rate = t.n === 0 ? NaN : t.k / t.n;
  return `${t.k}/${t.n} = ${Number.isNaN(rate) ? "n/a" : rate.toFixed(3)}  95% CI [${lo.toFixed(3)}, ${hi.toFixed(3)}]`;
}

/**
 * The pre/post boundary is item 156's directive fix. Cells either side of it ran different
 * prompts, so a figure spanning it is a MIXED POPULATION and may not be read as a larger sample
 * of one thing — which is exactly what the all-time 1-of-8 figure is.
 */
export const DIRECTIVE_FIX_CUTOVER_MS = Date.parse("2026-08-14T21:00:00Z");

export function report(capturesDir: string): string {
  const cells = loadPinnedCells(capturesDir).map(scoreCell);
  const out: string[] = [];
  const tasks = [...new Set(cells.map((c) => c.taskId))].sort();

  out.push(`pinned-model arm-B cells: ${cells.length} across ${tasks.length} tasks`);
  out.push("");
  out.push("per task, per definition (pre-fix / post-fix / all-time MIXED):");
  for (const t of tasks) {
    const all = cells.filter((c) => c.taskId === t);
    const pre = all.filter((c) => c.timestampMs < DIRECTIVE_FIX_CUTOVER_MS);
    const post = all.filter((c) => c.timestampMs >= DIRECTIVE_FIX_CUTOVER_MS);
    out.push(`  ${t}:`);
    for (const def of ["SEARCHED", "CORRECT_BASENAME", "CORRECT_FULLPATH"] as Definition[]) {
      const scorability = all[0]?.scorability === "scoreable" || def === "SEARCHED"
        ? ""
        : "   [UNSCOREABLE — correctFile is null]";
      out.push(
        `    ${def.padEnd(17)} pre ${fmt(tally(pre, def))}` +
          `  post ${fmt(tally(post, def))}${scorability}`
      );
    }
  }

  out.push("");
  out.push("ambiguity classes:");
  const basenameOnly = cells.filter((c) => c.basenameOnly);
  const unscoreable = cells.filter((c) => c.scorability === "unscoreable_no_ground_truth");
  out.push(
    `  basename-only (answer names the file, not its path): ${
      basenameOnly.length === 0 ? "none" : [...new Set(basenameOnly.map((c) => c.taskId))].sort().join(", ")
    }`
  );
  out.push(
    `  unscoreable under CORRECT_* (no ground truth): ${
      unscoreable.length === 0 ? "none" : [...new Set(unscoreable.map((c) => c.taskId))].sort().join(", ")
    }`
  );
  return out.join("\n");
}

function main(): void {
  const dir = process.argv[2] ?? ".zone/audits/notice-regression-arm";
  if (!fs.existsSync(dir)) {
    console.error(`[rescore] no captures directory at ${dir}`);
    process.exit(1);
  }
  console.log(report(dir));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
