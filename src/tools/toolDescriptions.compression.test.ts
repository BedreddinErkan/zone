/**
 * Phase 5 B.4 — description compression regression guard.
 *
 * These assertions prevent re-inflation of the top-5 description offenders.
 * Thresholds are set to compressed targets; tighten them if descriptions shrink further.
 */
import { describe, it, expect } from "vitest";
import { ZONE_TOOLS } from "./toolDefinitions.js";
import { checkCommandSafe } from "../llm/runCommandSafe.js";

function descriptionOf(name: string): string {
  const tool = ZONE_TOOLS.find((t) => t.function.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.function.description ?? "";
}

describe("Tool description compression (Phase 5 B.4)", () => {
  it("apply_patch description < 300 chars (behavioral directives preserved)", () => {
    const d = descriptionOf("apply_patch");
    expect(d.length).toBeLessThan(300);
    // Key behavioral directives must survive compression
    expect(d).toMatch(/FIND/);
    expect(d).toMatch(/re-read/);
    expect(d).toMatch(/EXISTING/);
  });

  it("search_in_files description < 200 chars", () => {
    expect(descriptionOf("search_in_files").length).toBeLessThan(200);
  });

  it("Task description < 150 chars", () => {
    expect(descriptionOf("Task").length).toBeLessThan(150);
  });

  it("suggest_scope_change description < 130 chars", () => {
    expect(descriptionOf("suggest_scope_change").length).toBeLessThan(130);
  });

  it("TodoWrite description < 100 chars", () => {
    expect(descriptionOf("TodoWrite").length).toBeLessThan(100);
  });
});

// Fix pass (2026-08-12): run_command_readonly's description named no discovery binary
// at all — "read-only git/filesystem inspection" with test/typecheck examples only. An
// agent holding this tool had no way to learn ls/find/fd/grep/rg or read-only git
// log/diff/show/blame/grep/ls-files were reachable. The two blocks below are the
// anti-drift mechanism the plan asked for: text assertions pin what the description
// SAYS, gate assertions (via the real, exported checkCommandSafe — not a re-hardcoded
// copy of the whitelist) pin what it actually MEANS. Either can go stale independently;
// see runCommandSafe.ts for the source of truth both are checked against.
describe("run_command_readonly names its discovery capability (fix pass)", () => {
  const description = descriptionOf("run_command_readonly");

  it.each([
    ["ls", /\bls\b/],
    ["find", /\bfind\b/],
    ["fd", /\bfd\b/],
    ["grep", /\bgrep\b/],
    ["rg", /\brg\b/],
    ["git log", /\blog\b/],
    ["git diff", /\bdiff\b/],
    ["git show", /\bshow\b/],
    ["git blame", /\bblame\b/],
    ["git ls-files", /\bls-files\b/],
  ])("names discovery binary: %s", (_label, re) => {
    expect(description).toMatch(re as RegExp);
  });

  // "grep" is named once in the description (the word covers both the standalone binary
  // and "git grep" — see the description's own two parenthetical groups), but the two are
  // distinct WHITELIST_PREFIXES entries, so both get their own live gate check even though
  // only one text assertion above covers the word itself.
  it.each([
    ["ls -la", true],
    ["find . -name '*.ts'", true],
    ["fd pattern", true],
    ["grep -rn pattern src", true],
    ["rg pattern src", true],
    ["git log --oneline -5", true],
    ["git diff --stat", true],
    ["git show HEAD", true],
    ["git blame src/foo.ts", true],
    ["git grep pattern", true],
    ["git ls-files", true],
  ])("named binary passes the real whitelist: checkCommandSafe(%s).safe === %s", (cmd, expected) => {
    expect(checkCommandSafe(cmd as string).safe).toBe(expected);
  });

  it("states the structural constraints: no chaining, no substitution, no write redirects", () => {
    expect(description).toMatch(/chain/i);
    expect(description).toMatch(/substitution/i);
    expect(description).toMatch(/redirect/i);
  });
});
