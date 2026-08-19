/**
 * Guards the theme-seam extraction against silently regressing to incomplete as later passes
 * extend it. Frame-diff — this arc's own per-pass verification step — cannot detect an incomplete
 * extraction: a literal "cyan" left behind in a component renders identically to role.accent
 * today, so it is invisible to any comparison of rendered output. Completeness is a property of
 * the source text, not of what it renders, so it needs a separate, static instrument. This is it.
 *
 * EXTRACTED_FILES is the mechanism a later pass depends on: the Part-2 pass applying this
 * vocabulary across the remaining components extends this list, and from that point on this test
 * guards those files too. A file left off the list is not covered by this guard — the same
 * "declared, not everything" discipline as scripts/gitignoreTrackedFiles.test.ts's own scope and
 * scripts/markerAttribution.test.ts's SELF_EXCLUDED_PATHS.
 *
 * FORBIDDEN_COLOUR_LITERALS / FORBIDDEN_GLYPHS are derived from theme.ts's own exports rather than
 * hand-copied — adding a role or a glyph to the seam automatically extends what this sweep
 * forbids elsewhere, instead of requiring a second, parallel edit someone can forget. That is the
 * exact failure shape dispatchReasonAgreement.test.ts's own header describes for the
 * dispatch-reason vocabulary: three independent copies of one list, silently diverging.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { role, glyph } from "./theme.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** Production files whose colour/glyph literals have been extracted into theme.ts. The Part-2
 *  pass across the remaining components extends this list; the test starts guarding a file the
 *  moment its path is added here. */
const EXTRACTED_FILES = [
  // Part 1 (f39ce482)
  "src/cli/tui/components/Composer.tsx",
  "src/cli/tui/components/Transcript.tsx",
  "src/cli/tui/components/ApiKeysView.tsx",
  "src/cli/tui/components/PlanBody.tsx",
  "src/cli/tui/components/MarkdownText.tsx",
  "src/cli/tui/components/Spinner.tsx",
  "src/cli/tui/components/ModelModal.tsx",
  "src/cli/tui/components/StatusBar.tsx",
  // Part 2, commit 1 — proves the new glyph vocabulary
  "src/cli/tui/components/ErrorLine.tsx",
  "src/cli/tui/components/ToolCallGroup.tsx",
  "src/cli/tui/components/CommandTail.tsx",
  "src/cli/tui/components/ToolCall.tsx",
  "src/cli/tui/components/toolCallFormat.ts",
  "src/cli/tui/components/PlanPanel.tsx",
  "src/cli/tui/components/PermissionsView.tsx",
  "src/cli/tui/components/EffortModal.tsx",
];

const FORBIDDEN_COLOUR_LITERALS = [...new Set(Object.values(role))];
const FORBIDDEN_GLYPHS = [...new Set(Object.values(glyph))];

/** Escapes `s` for literal use inside a RegExp source string. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Occurrences of `needle` written as a quoted JS/TS string literal ("needle" or 'needle') in `text`. */
function quotedLiteralCount(text: string, needle: string): number {
  const re = new RegExp(`["']${escapeRegExp(needle)}["']`, "g");
  return [...text.matchAll(re)].length;
}

function readExtracted(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of EXTRACTED_FILES) {
    out.set(rel, fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
  }
  return out;
}

describe("harness floor — proven before any absence claim below is trusted", () => {
  it("the declared file list is non-empty (an empty list would pass every check below vacuously)", () => {
    expect(EXTRACTED_FILES.length).toBeGreaterThan(0);
  });

  it("theme.ts exports at least one role and one glyph (an empty seam makes the sweep vacuous)", () => {
    expect(FORBIDDEN_COLOUR_LITERALS.length).toBeGreaterThan(0);
    expect(FORBIDDEN_GLYPHS.length).toBeGreaterThan(0);
  });

  it("every declared file exists on disk — a renamed file silently dropping out of coverage fails here, not silently", () => {
    for (const rel of EXTRACTED_FILES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} is declared in EXTRACTED_FILES but missing`).toBe(true);
    }
  });

  it("PROOF THE INSTRUMENT WORKS: the scanner catches a deliberately reintroduced literal", () => {
    // Run every suite execution, not only during a manual mutation pass. Constructs the exact
    // shape a bypassed extraction would leave — a forbidden literal quoted inside a plausible
    // line of JSX or TS — using the same scanning function the real assertions below use. If this
    // ever reports zero, the assertions below are not measuring what they claim to.
    const colourBypass = `export const Foo = () => <Text color="${FORBIDDEN_COLOUR_LITERALS[0]}">hi</Text>;`;
    expect(quotedLiteralCount(colourBypass, FORBIDDEN_COLOUR_LITERALS[0]!)).toBeGreaterThan(0);

    const glyphBypass = `const cursor = "${FORBIDDEN_GLYPHS[0]}";`;
    expect(quotedLiteralCount(glyphBypass, FORBIDDEN_GLYPHS[0]!)).toBeGreaterThan(0);

    // And the negative control: theme.ts's own role-name KEYS (not values) must not false-positive.
    expect(quotedLiteralCount(`const x = "accent";`, FORBIDDEN_COLOUR_LITERALS[0]!)).toBe(0);
  });
});

describe("theme-seam completeness — no colour literal or extracted glyph survives outside theme.ts", () => {
  it("no declared file contains a forbidden colour literal", () => {
    const files = readExtracted();
    const offenders: string[] = [];
    for (const [rel, text] of files) {
      for (const lit of FORBIDDEN_COLOUR_LITERALS) {
        if (quotedLiteralCount(text, lit) > 0) offenders.push(`${rel}: "${lit}"`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("no declared file contains an extracted glyph as a bare literal", () => {
    const files = readExtracted();
    const offenders: string[] = [];
    for (const [rel, text] of files) {
      for (const g of FORBIDDEN_GLYPHS) {
        if (quotedLiteralCount(text, g) > 0) offenders.push(`${rel}: "${g}"`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("every declared file actually imports from theme.ts", () => {
    // Closes the gap the two checks above cannot: a file rewritten to avoid theme.ts entirely
    // (hardcoded ANSI, or the feature simply deleted) would show zero forbidden literals without
    // being extracted at all — this is not caught by string-absence, only by import presence.
    const files = readExtracted();
    for (const [rel, text] of files) {
      expect(
        /from ["'][./]+theme\.js["']/.test(text),
        `${rel} is declared in EXTRACTED_FILES but does not import from theme.ts`
      ).toBe(true);
    }
  });
});
