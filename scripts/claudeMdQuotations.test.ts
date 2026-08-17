import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * Ledger item 184 — CLAUDE.md states its own convention (opening paragraph, right after the
 * title): a backtick-quoted expression attributed to a named source file is byte-exact and
 * checked; every other expression rendered elsewhere in the guide's prose is paraphrase —
 * prefixes stripped, multi-clause conditions compressed — and is not a claim this file protects.
 *
 * THE PAIRS BELOW ARE THE ENTIRE CHECKED SET, not a sample. Item 184's own establish pass swept
 * every expression-shaped backtick span in CLAUDE.md (21 candidates beyond the first) and found
 * exactly one other genuine byte-exact quotation among them (`isHeadless`) — the rest are
 * paraphrase under CLAUDE.md's own stated convention, confirmed by reading each against its real
 * source, not assumed. Do not add a pair here for a paraphrase, and do not "fix" a paraphrase
 * into a quotation to make it checkable — that is exactly the false economy the convention
 * exists to rule out. A new pair belongs here only when CLAUDE.md's prose itself starts
 * asserting byte-exactness for a new expression (the same shape as the two below: a bare,
 * unprefixed expression attributed to one named file).
 */

const REPO_ROOT = path.resolve(__dirname, "..");
const CLAUDE_MD_PATH = path.join(REPO_ROOT, "CLAUDE.md");

interface QuotedPredicate {
  readonly text: string;
  readonly sourcePath: string;
}

export const TASK_BLOCKED_BY_BUDGET: QuotedPredicate = {
  text: "(tierLimits?.maxSubagentCalls ?? Infinity) === 0 || taskIsSmall",
  sourcePath: "src/llm/agentLoop.ts",
};

export const IS_HEADLESS: QuotedPredicate = {
  text: 'isHeadless = options.print === true || !process.stdout.isTTY',
  sourcePath: "src/cli/index.ts",
};

export const CHECKED_QUOTATIONS: readonly QuotedPredicate[] = [TASK_BLOCKED_BY_BUDGET, IS_HEADLESS];

describe("CLAUDE.md quotations (ledger item 184) — the checked set, not a sample", () => {
  const claudeMd = fs.readFileSync(CLAUDE_MD_PATH, "utf8");

  for (const { text, sourcePath } of CHECKED_QUOTATIONS) {
    describe(text.slice(0, 50), () => {
      const source = fs.readFileSync(path.join(REPO_ROOT, sourcePath), "utf8");

      it(`still occurs in CLAUDE.md`, () => {
        expect(claudeMd, "CLAUDE.md no longer quotes this predicate").toContain(text);
      });

      it(`still occurs in ${sourcePath}, the file CLAUDE.md attributes it to`, () => {
        expect(source, `${sourcePath} no longer contains the quoted predicate`).toContain(text);
      });
    });
  }
});
