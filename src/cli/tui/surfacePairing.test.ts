/**
 * A theme role that is declared but never consumed has no observer, and neither existing test can
 * supply one.
 *
 * theme.test.ts pins the KEY SET, so adding a role is a visible edit — but a role added there and
 * used nowhere passes it. themeCoverage.test.ts derives its forbidden-literal sweep from
 * Object.values(role), so a new role automatically extends what may not appear as a bare literal
 * elsewhere — but that is the inverse claim: it catches the value being hardcoded, never the role
 * going unused. Between them, `surfaceForeground` could ship declared, documented, and applied to
 * nothing.
 *
 * This is the missing half: the two sites that paint an app-controlled background must also set the
 * foreground that sits on it. Both sides of that pairing are then real hex, which is the condition
 * under which a contrast ratio exists at all — see contrast.ts.
 *
 * PRODUCER↔CONSUMER FROM ONE SOURCE. The pairing is named once, in PAIR. Both the scan pattern and
 * the assertion are built from it, and the guard below fails if either name stops being a key of
 * `role`. So renaming the role in theme.ts breaks this file at the guard rather than leaving it
 * quietly scanning for a property that no longer exists — which is what two hardcoded copies of the
 * string would have done.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { role } from "./theme.js";

const REPO_ROOT = path.resolve(__dirname, "../../..");

/** The one place either half of the pairing is named. */
const PAIR = { background: "surface", foreground: "surfaceForeground" } as const;

/** Components that paint PAIR.background as a box fill. Declared, like themeCoverage.ts's own
 *  list — and checked against reality by the sweep below, so a third site cannot appear unnoticed. */
const PAINTING_FILES = [
  "src/cli/tui/components/Composer.tsx",
  "src/cli/tui/components/Transcript.tsx",
];

/** Every non-test file under the TUI tree, for the "no undeclared painter" sweep. */
function tuiSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
      out.push(path.relative(REPO_ROOT, abs));
    }
  };
  walk(path.join(REPO_ROOT, "src/cli/tui"));
  return out;
}

/**
 * File text with comments removed.
 *
 * Load-bearing, and it was not in the first draft. Both call sites carry a comment EXPLAINING that
 * they set the paired foreground, and those comments contain the role name — so a scan of the raw
 * text matched the explanation rather than the code. Mutations that stripped the colour prop from
 * every run in a file were reported as surviving; they were not surviving, they were unobserved.
 * The same shape as a leak detector firing on its own echoed argument.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const read = (rel: string): string => stripComments(fs.readFileSync(path.join(REPO_ROOT, rel), "utf8"));
const readRaw = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
const paintsBackground = (text: string): boolean =>
  text.includes(`backgroundColor={role.${PAIR.background}}`);

describe("harness floor — proven before the pairing claims are trusted", () => {
  it("both halves of PAIR are real keys of role — a rename in theme.ts fails HERE", () => {
    const keys = Object.keys(role);
    expect(keys, `role has no "${PAIR.background}" — PAIR is stale`).toContain(PAIR.background);
    expect(keys, `role has no "${PAIR.foreground}" — PAIR is stale`).toContain(PAIR.foreground);
  });

  it("both halves are real hex, which is what makes a contrast ratio exist", () => {
    // A theme-relative name like "cyan" or "white" is resolved by the terminal, so a pairing
    // involving one has no computable ratio at all. That is the defect this pairing removes.
    expect(role[PAIR.background]).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(role[PAIR.foreground]).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("PROOF THE COMMENT STRIPPER WORKS: a role named only in a comment does not count", () => {
    // Without this the assertions below can be satisfied by prose. Constructed in the same shape
    // the real files carry, and run every execution rather than only during a mutation pass.
    expect(stripComments(`// sets role.${PAIR.foreground} here\nconst x = 1;`))
      .not.toContain(`role.${PAIR.foreground}`);
    expect(stripComments(`/* role.${PAIR.foreground} */ const y = 2;`))
      .not.toContain(`role.${PAIR.foreground}`);
    // And the negative control: real code survives stripping.
    expect(stripComments(`<Text color={role.${PAIR.foreground}}>x</Text>`))
      .toContain(`role.${PAIR.foreground}`);
  });

  it("both call sites DO mention the pairing in prose — which is why stripping is required", () => {
    // Not decoration: if this ever stops being true the stripper is untested by the real tree, and
    // the proof above becomes the only thing standing between this file and a prose-satisfied pass.
    for (const rel of PAINTING_FILES) {
      expect(readRaw(rel), `${rel} no longer explains the pairing`).toContain(`role.${PAIR.foreground}`);
    }
  });

  it("the declared painter list is non-empty and every entry really paints it", () => {
    expect(PAINTING_FILES.length).toBeGreaterThan(0);
    for (const rel of PAINTING_FILES) {
      expect(paintsBackground(read(rel)), `${rel} is declared but does not paint role.${PAIR.background}`).toBe(true);
    }
  });
});

/**
 * Extract the source of the painted box itself, by depth-counting Box tags from the fill outward.
 *
 * The file-level checks below cannot see a SINGLE run losing its colour while its siblings keep
 * theirs — measured: dropping the prop from one of three runs left every one of them passing. This
 * region scan is what closes that, and it is why the invariant is stated per run rather than per
 * file.
 */
function paintedRegion(text: string): string {
  const start = text.indexOf(`backgroundColor={role.${PAIR.background}}`);
  if (start === -1) return "";
  const open = text.lastIndexOf("<Box", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text.startsWith("<Box", i)) depth++;
    else if (text.startsWith("</Box>", i)) {
      depth--;
      if (depth === 0) return text.slice(open, i + 6);
    }
  }
  return text.slice(open);
}

describe("no text run on an app-painted fill inherits the terminal's foreground", () => {
  it("PROOF THE REGION SCAN WORKS: it finds a run missing its colour in a constructed box", () => {
    const bad = `<Box backgroundColor={role.${PAIR.background}}><Text>x</Text></Box>`;
    const region = paintedRegion(bad);
    expect(region).toContain("<Text>");
    expect((region.match(/<Text[ >]/g) ?? []).length).toBe(1);
    expect((region.match(/<Text[^>]*\scolor=/g) ?? []).length).toBe(0);
    // Negative control: a well-formed box reports no shortfall.
    const good = `<Box backgroundColor={role.${PAIR.background}}><Text color={role.x}>x</Text></Box>`;
    const gr = paintedRegion(good);
    expect((gr.match(/<Text[ >]/g) ?? []).length).toBe((gr.match(/<Text[^>]*\scolor=/g) ?? []).length);
  });

  it("every run inside each painted box sets a colour — role.accent is allowed, inheriting is not", () => {
    // Deliberately not "every run uses PAIR.foreground": Transcript's prompt marker uses
    // role.accent on purpose, and should. The invariant is that the APP chooses, not the terminal.
    for (const rel of PAINTING_FILES) {
      const region = paintedRegion(read(rel));
      expect(region.length, `${rel}: could not locate the painted box`).toBeGreaterThan(0);
      const runs = (region.match(/<Text[ >]/g) ?? []).length;
      const coloured = (region.match(/<Text[^>]*\scolor=/g) ?? []).length;
      expect(coloured, `${rel}: ${runs - coloured} of ${runs} text runs on the fill set no colour`).toBe(runs);
    }
  });
});

describe("an app-painted background always carries an app-set foreground", () => {
  it("every declared painter also references the paired foreground", () => {
    const offenders = PAINTING_FILES.filter((rel) => !read(rel).includes(`role.${PAIR.foreground}`));
    expect(
      offenders,
      `these paint role.${PAIR.background} without ever setting role.${PAIR.foreground}, so their text ` +
        `colour is whatever the terminal defaults to:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("no undeclared file paints it — a third site cannot appear unguarded", () => {
    // The converse of the declared list, and the gap a declaration alone cannot see.
    const painters = tuiSourceFiles().filter((rel) => paintsBackground(read(rel)));
    expect(painters.length, "no painters found at all — the walk is broken, not the tree").toBeGreaterThan(0);
    const declared = new Set(PAINTING_FILES);
    expect(painters.filter((f) => !declared.has(f)).sort()).toEqual([]);
  });

  it("negative control — a role that is NOT half of this pairing is not required anywhere", () => {
    // Guards against an assertion that would pass for any role name at all.
    const bogus = PAINTING_FILES.filter((rel) => !read(rel).includes("role.thisRoleDoesNotExist"));
    expect(bogus).toEqual(PAINTING_FILES);
  });
});
