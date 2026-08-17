/**
 * Re-derives item 193's headline figures from docs/data/item193-results-v1.jsonl (the tracked
 * mirror of the run's own .zone/item193/results-v1.jsonl, which is gitignored and not durable).
 * No producer script for that file exists anywhere in this repository — confirmed absent by two
 * independent instruments neither of which was git grep, since .zone/ is gitignored and git grep
 * returning zero there is not evidence of absence.
 *
 * D1's two hypotheses recover a semantics for the file's own `agreement` field that has no live
 * emitter to read it from: the reproduction rate against that stored field IS the evidence for
 * the recovered reading, not an assumption transcribed from a prior report. Run this file's own
 * test to see both rates re-derived from zero.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResultRecord {
  arm: string;
  fixture: string;
  ecosystem: string;
  detectedTestCommand: string;
  invokedTestCommands: string[];
  invokedCommands: string[];
  agreement: "agree" | "disagree";
}

export function parseResults(raw: string): ResultRecord[] {
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ResultRecord);
}

/**
 * Every invoked test command equals the detected command verbatim.
 *
 * Array.prototype.every is vacuously true on an empty array — deliberately overridden to false
 * here: "every one of zero invocations matched" is not agreement, it is the absence of an
 * attempt, and the vacuous-true default would be a JavaScript artefact rather than a recovered
 * semantics. The 40 real records never exercise this branch (0/40 have an empty
 * invokedTestCommands, confirmed by two instruments before this function was written) — the
 * guard is here for correctness against data this script has not yet seen, not because it
 * changes any currently recorded figure.
 */
export function hStrict(r: ResultRecord): boolean {
  if (r.invokedTestCommands.length === 0) return false;
  return r.invokedTestCommands.every((c) => c === r.detectedTestCommand);
}

/**
 * At least one invoked test command equals the detected command verbatim.
 *
 * Array.prototype.some is already vacuously false on an empty array, which is the correct
 * reading here without any override — included for symmetry with hStrict's explicit guard, not
 * because the default needed changing.
 */
export function hAny(r: ResultRecord): boolean {
  return r.invokedTestCommands.some((c) => c === r.detectedTestCommand);
}

export interface ReproductionRate {
  matched: number;
  total: number;
  rate: string;
  perArm: Record<string, { matched: number; total: number }>;
}

/** Compares hypothesis(r) ? "agree" : "disagree" against the record's own stored `agreement`
 *  field and reports the match rate, overall and per arm. */
export function reproductionRate(
  records: ResultRecord[],
  hypothesis: (r: ResultRecord) => boolean,
): ReproductionRate {
  let matched = 0;
  const perArm: Record<string, { matched: number; total: number }> = {};
  for (const r of records) {
    const derived = hypothesis(r) ? "agree" : "disagree";
    const hit = derived === r.agreement;
    if (hit) matched++;
    if (!perArm[r.arm]) perArm[r.arm] = { matched: 0, total: 0 };
    perArm[r.arm].total++;
    if (hit) perArm[r.arm].matched++;
  }
  return { matched, total: records.length, rate: `${matched}/${records.length}`, perArm };
}

/** Some invoked test command is either exactly the detected command, or the detected command
 *  followed by a space — a longer invocation (e.g. a pipe wrapper) that still leads with it. */
export function invokedDetectedRunnerLeadingToken(r: ResultRecord): boolean {
  return r.invokedTestCommands.some(
    (c) => c === r.detectedTestCommand || c.startsWith(`${r.detectedTestCommand} `),
  );
}

/** Some invoked test command is exactly the detected command — the strict subset of the
 *  leading-token reading above. */
export function invokedDetectedRunnerBare(r: ResultRecord): boolean {
  return r.invokedTestCommands.some((c) => c === r.detectedTestCommand);
}

export function countBy(records: ResultRecord[], predicate: (r: ResultRecord) => boolean): number {
  return records.filter(predicate).length;
}

/** Tallies the first whitespace-delimited token of every invokedCommands entry across every
 *  record. No JS-runner name appears anywhere in this function — absence of a runner such as
 *  vitest or jest is read off the printed tally by a human, not asserted by a pattern that
 *  could itself be wrong or go stale. */
export function leadingBinaryTally(records: ResultRecord[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const r of records) {
    for (const cmd of r.invokedCommands) {
      const token = cmd.trim().split(/\s+/)[0];
      if (!token) continue;
      tally[token] = (tally[token] ?? 0) + 1;
    }
  }
  return tally;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The committed, tracked copy — the default, because it is what exists on a fresh clone.
 *  .zone/ is gitignored, so the raw .zone/item193/results-v1.jsonl this was copied from may not
 *  exist there. A path argument to main() overrides this default. */
export const DEFAULT_RESULTS_PATH = path.join(REPO_ROOT, "docs", "data", "item193-results-v1.jsonl");

function formatReport(records: ResultRecord[]): string {
  const hAnyRate = reproductionRate(records, hAny);
  const hStrictRate = reproductionRate(records, hStrict);
  const leadCount = countBy(records, invokedDetectedRunnerLeadingToken);
  const bareCount = countBy(records, invokedDetectedRunnerBare);
  const tally = leadingBinaryTally(records);
  const tallyEntries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const tallyTotal = tallyEntries.reduce((sum, [, count]) => sum + count, 0);

  const lines: string[] = [];
  lines.push("=== D1 -- agreement field reproduction (recovered, not read from a live emitter) ===");
  lines.push(`  hAny    (>=1 exact match): ${hAnyRate.rate}  per-arm: ${JSON.stringify(hAnyRate.perArm)}`);
  lines.push(`  hStrict (every exact match): ${hStrictRate.rate}  per-arm: ${JSON.stringify(hStrictRate.perArm)}`);
  lines.push("");
  lines.push("=== D2 -- detected-runner invocation ===");
  lines.push(`  leading-token match: ${leadCount}/${records.length}`);
  lines.push(`  bare exact match:    ${bareCount}/${records.length}`);
  lines.push("");
  lines.push("=== D3 -- leading-binary alphabet (full tally, no runner-name pattern) ===");
  for (const [bin, count] of tallyEntries) {
    lines.push(`  ${bin.padEnd(12)} ${count}`);
  }
  lines.push(`  ${"TOTAL".padEnd(12)} ${tallyTotal}`);
  return lines.join("\n");
}

export function main(jsonlPath?: string): void {
  const target = jsonlPath ? path.resolve(jsonlPath) : DEFAULT_RESULTS_PATH;
  const raw = fs.readFileSync(target, "utf8");
  const records = parseResults(raw);
  console.log(`item193Figures -- ${records.length} records from ${target}`);
  console.log(formatReport(records));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
