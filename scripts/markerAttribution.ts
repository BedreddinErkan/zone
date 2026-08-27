/**
 * Marker-name attribution — for a `[zone-*]` marker name, which files actually emit it versus
 * which merely mention it.
 *
 * Item 196 (docs/deferred-work.md) was corrupted by exactly this confusion: a comment in
 * `commandApprovals.ts` named `[zone-run-command-readonly-blocked]` — the sibling gate's own
 * marker, emitted from `toolExecutor.ts` — and a text search for the marker name found that
 * comment and read it as an emission. The correction was written in prose; this file makes the
 * distinction checkable instead of re-derived by eye each time.
 *
 * WHAT "EMITTING" MEANS. A single fixed list of emitter function names (`log`/`debugLog`/
 * `console.*`) is not enough — the tree uses at least three distinct shapes:
 *
 *   1. Direct literal: `log("[zone-x]", ...)`, `console.warn("[zone-x]")`, and same-shape calls
 *      under other names (`emitLog(...)`, a function *parameter* in postToolUseHook.ts and
 *      index.tsx, not a fixed global). The callee name varies; the call shape — the marker as a
 *      whole quoted argument, or as a template literal's leading static prefix — does not.
 *      Matching the SHAPE rather than a name list catches every current wrapper and any future
 *      one without needing to be told about it.
 *   2. Two-argument dispatch: `ctx.emit("log", "[zone-x]", payload)`, routed through a generic
 *      `emit: (level, marker, payload) => log(marker, ...)` callback (agentLoop.ts and the
 *      history-processor modules). The callback's OWN call site has a *variable* first
 *      argument and would read as markerless to a literal-only scan; the true attribution point
 *      is the `ctx.emit(...)` call, where the marker is still a literal argument — shape 1's
 *      rule already covers it without special-casing the name `ctx.emit`.
 *   3. Object-literal-then-raw-write: `markerSink.ts` alone, `{ name: "[zone-x]", ... }` built
 *      and passed straight to `fs.appendFileSync`/`fs.writeFileSync` with no call ever carrying
 *      the literal as an argument. Detected by shape (a `name:`/`event:` property holding the
 *      exact marker, in a file that also calls one of those two write functions), not by
 *      hardcoding the one file that happens to do this today.
 *
 * RULED OUT: fully dynamic tag construction — `` `[zone-${category}]` `` interpolating the
 * *whole* bracketed tag. A tree-wide search for `\[zone-\$\{` returns zero matches; every
 * template-literal emission found has the complete tag as a literal prefix, with only the
 * trailing message dynamic. If that ever changes, this file's shape-based matching would go
 * silent on the newly-dynamic marker rather than misattribute it — a gap to notice, not a wrong
 * answer to trust.
 *
 * FILE-KIND RESTRICTION. Mentions are tracked across every file kind; only SOURCE files can be
 * credited as emitters. An earlier, unrestricted version of this sweep credited markdown prose
 * and test-file mock assertions as "emitters" — the exact defect class this file exists to
 * prevent, one level up — because a quoted-then-comma-or-paren shape appears in prose sentences
 * and in `expect(...).toHaveBeenCalledWith("[zone-x]", ...)` too. Restricting the emitter side
 * to real, non-test source is what makes the distinction meaningful.
 *
 * NOT covered, stated rather than silently omitted: the four existing comments that name
 * another module's marker as a sibling or model (e.g. commandApprovals.ts's own comment about
 * run_command_readonly's marker) are accurate prose and are left untouched. This file reports
 * attribution; it does not fail a check against them.
 *
 * Usage:
 *   npx tsx scripts/markerAttribution.ts             # full tree report
 *   npx tsx scripts/markerAttribution.ts "[zone-x]"   # one marker's attribution
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every `[zone-*]` marker name shape used in this tree. */
export const MARKER_NAME_RE = /\[zone-[a-z0-9][a-z0-9-]*\]/g;

export type FileKind = "source" | "test" | "doc" | "snapshot" | "script" | "manual-probe";

/**
 * Precedence matters: `.test.ts` files can live under `scripts/`
 * (`deferredWorkAnaphorSweep.test.ts`), so `test` is checked before `script`; manual-probe
 * paths (`__tests__/`) are also `.ts`, so checked before the `source` fallback.
 */
export function fileKind(filePath: string): FileKind {
  if (/^docs\//.test(filePath) || /\.md$/.test(filePath)) return "doc";
  if (/\.json$/.test(filePath) || /snapshot/i.test(filePath)) return "snapshot";
  if (/\.test\.tsx?$/.test(filePath)) return "test";
  if (/__tests__/.test(filePath)) return "manual-probe";
  if (/^scripts\//.test(filePath)) return "script";
  return "source";
}

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

/**
 * True when `line`, ignoring leading whitespace, opens with a comment marker: `//`, a JSDoc/
 * block-comment continuation `*` (not `*/`, which closes one), or a block-comment opener `/*`.
 * A code span inside a comment (`` `[zone-x]` ``) reads identically to a template-literal prefix
 * to a line-based scan; this is what tells them apart. Checked against the real tree before being
 * written, not assumed: every current backtick-adjacent false credit (three markers, one file
 * each - item 196, docs/deferred-work.md) is a leading-anchor comment line, and none of the
 * fifty-five genuine template-literal emissions in the tree are.
 *
 * NOT CAUGHT, stated rather than silently accepted: an inline trailing comment on a line that
 * also has real code before it, and a block-comment continuation line missing its leading `*`.
 * Neither currently occurs in this tree - checked against every real hit this rule affects, not
 * assumed absent.
 */
const COMMENT_LINE_RE = /^\s*(\/\/|\*(?!\/)|\/\*)/;

/**
 * Shape 1/2: `name` appears as a whole quoted argument (optionally the second argument of a
 * two-argument dispatch call, which this still matches since it only looks at the quoted token
 * itself and what follows it), or as a template literal's leading static prefix. Gated on
 * COMMENT_LINE_RE first - applied to both branches, not just the backtick one: the quote+comma
 * branch has zero real-tree comment hits today, but gating it too costs nothing and closes the
 * same false-positive shape should it ever occur.
 */
export function isEmittingLine(line: string, name: string): boolean {
  if (COMMENT_LINE_RE.test(line)) return false;
  const esc = escapeForRegex(name);
  const wholeArgument = new RegExp(`["'\`]${esc}["'\`]\\s*[,)]`);
  const templatePrefix = new RegExp("`" + esc);
  return wholeArgument.test(line) || templatePrefix.test(line);
}

/**
 * Shape 3: an object-literal `name:`/`event:` property holding the exact marker, in a file that
 * also calls a raw filesystem write — markerSink.ts's own shape, detected structurally rather
 * than by hardcoding that path.
 */
export function hasSinkWriteShape(fileText: string, name: string): boolean {
  const esc = escapeForRegex(name);
  const objectLiteral = new RegExp(`(?:name|event)\\s*:\\s*["'\`]${esc}["'\`]`);
  const rawWrite = /\.(?:appendFileSync|writeFileSync)\s*\(/;
  return objectLiteral.test(fileText) && rawWrite.test(fileText);
}

export interface FileInput {
  path: string;
  text: string;
}

export interface MarkerAttribution {
  name: string;
  /** Every file (any kind) containing the literal marker string. Sorted. */
  mentionedIn: string[];
  /** Source files where the marker is actually emitted (shapes 1-3). Sorted. */
  emittedIn: string[];
}

/** Pure — takes file contents rather than reading disk, so it is testable against fixtures. */
export function scanTree(files: FileInput[]): Map<string, MarkerAttribution> {
  const mentions = new Map<string, Set<string>>();
  const emits = new Map<string, Set<string>>();

  for (const { path: p, text } of files) {
    const namesInFile = new Set(text.match(MARKER_NAME_RE) ?? []);
    if (namesInFile.size === 0) continue;

    for (const name of namesInFile) {
      if (!mentions.has(name)) mentions.set(name, new Set());
      mentions.get(name)!.add(p);
    }

    if (fileKind(p) !== "source") continue;

    for (const line of text.split("\n")) {
      const lineNames = line.match(MARKER_NAME_RE) ?? [];
      for (const name of lineNames) {
        if (isEmittingLine(line, name)) {
          if (!emits.has(name)) emits.set(name, new Set());
          emits.get(name)!.add(p);
        }
      }
    }

    for (const name of namesInFile) {
      if (hasSinkWriteShape(text, name)) {
        if (!emits.has(name)) emits.set(name, new Set());
        emits.get(name)!.add(p);
      }
    }
  }

  const result = new Map<string, MarkerAttribution>();
  for (const [name, mset] of mentions) {
    result.set(name, {
      name,
      mentionedIn: [...mset].sort(),
      emittedIn: [...(emits.get(name) ?? new Set<string>())].sort(),
    });
  }
  return result;
}

export interface Hazard {
  file: string;
  marker: string;
  emitters: string[];
}

/**
 * The check a future pass runs before trusting a marker count: a source file mentions a marker
 * it does not itself emit, and a real emitter exists in a *different* source file — the exact
 * shape that corrupted item 196.
 */
export function hazards(result: Map<string, MarkerAttribution>): Hazard[] {
  const out: Hazard[] = [];
  for (const attr of result.values()) {
    if (attr.emittedIn.length === 0) continue;
    for (const file of attr.mentionedIn) {
      if (fileKind(file) !== "source") continue;
      if (attr.emittedIn.includes(file)) continue;
      out.push({ file, marker: attr.name, emitters: attr.emittedIn });
    }
  }
  return out.sort((a, b) => (a.file === b.file ? a.marker.localeCompare(b.marker) : a.file.localeCompare(b.file)));
}

/**
 * This module and its test carry marker-shaped strings that are fixtures and documentation
 * examples, not markers this codebase emits. Counting them would make the inventory an
 * inventory of itself.
 *
 * The defect this prevents is specific and was shipped once: the drift assertion's expected
 * figures were first measured while both files were still UNTRACKED, so `git ls-files` could
 * not see them and their eight fixture names were absent from the count. Committing the files
 * made those names visible and moved the total from 406 to 414 — a test that passed before the
 * commit and failed immediately after it, for a reason that had nothing to do with the tree it
 * claims to measure. Excluding them here makes the figure mean "markers in the codebase" in
 * both states.
 */
export const SELF_EXCLUDED_PATHS: readonly string[] = [
  "scripts/markerAttribution.ts",
  "scripts/markerAttribution.test.ts",
];

/** Reads every tracked file that could contain a marker, minus this tool's own two. */
export function readTrackedFiles(): FileInput[] {
  const raw = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
  const paths = raw.split("\0").filter(Boolean);
  const files: FileInput[] = [];
  for (const p of paths) {
    if (SELF_EXCLUDED_PATHS.includes(p)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, p), "utf8");
    } catch {
      continue; // binary or unreadable — cannot contain a matchable marker string either way
    }
    if (text.includes("[zone-")) files.push({ path: p, text });
  }
  return files;
}

/**
 * Every file `readTrackedFiles()` would see AFTER `git add -A` — every currently tracked path,
 * PLUS every untracked-but-not-gitignored path, all read from disk. `--exclude-standard` matters:
 * without it this would pull in `dist/` (gitignored, full of compiled marker literals) on any
 * machine that has run a build.
 *
 * This exists to answer one question: does the tracked-only scan `readTrackedFiles()` performs
 * currently agree with what the tree would scan as once staged? A "yes" from `driftGuardOk` below
 * is what makes the drift-check assertion trustworthy; this function alone does not check anything.
 */
export function readWorktreeFiles(): FileInput[] {
  const trackedRaw = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" });
  const untrackedRaw = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: REPO_ROOT, encoding: "utf8" }
  );
  const paths = [...trackedRaw.split("\0"), ...untrackedRaw.split("\0")].filter(Boolean);
  const files: FileInput[] = [];
  for (const p of paths) {
    if (SELF_EXCLUDED_PATHS.includes(p)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, p), "utf8");
    } catch {
      continue;
    }
    if (text.includes("[zone-")) files.push({ path: p, text });
  }
  return files;
}

export interface DriftSummary {
  size: number;
  dist: { zero: number; one: number; several: number };
  hazardCount: number;
}

export function summarize(result: Map<string, MarkerAttribution>): DriftSummary {
  const dist = { zero: 0, one: 0, several: 0 };
  for (const attr of result.values()) {
    const c = attr.emittedIn.length;
    if (c === 0) dist.zero++;
    else if (c === 1) dist.one++;
    else dist.several++;
  }
  return { size: result.size, dist, hazardCount: hazards(result).length };
}

/**
 * The structural fix for the recurring "passed locally, failed in CI" incident (406->414, then
 * 415->417 — docs/deferred-work.md item 391). A code comment recording the first occurrence did
 * not prevent the second, so this checks it instead: compares the tracked-only summary (what the
 * drift-check below asserts against) with the full-worktree summary (what the SAME assertion would
 * see after `git add -A`). They agree on a clean tree and on a fully-staged one; they disagree
 * exactly when an untracked or unstaged-modified file would change the count, the distribution, or
 * the hazard list once staged — which is precisely the condition under which the drift-check's
 * hardcoded numbers cannot be trusted, whichever way they currently point.
 */
export function driftGuardOk(): { ok: true } | { ok: false; tracked: DriftSummary; worktree: DriftSummary } {
  const tracked = summarize(scanTree(readTrackedFiles()));
  const worktree = summarize(scanTree(readWorktreeFiles()));
  const ok =
    tracked.size === worktree.size &&
    tracked.hazardCount === worktree.hazardCount &&
    tracked.dist.zero === worktree.dist.zero &&
    tracked.dist.one === worktree.dist.one &&
    tracked.dist.several === worktree.dist.several;
  return ok ? { ok: true } : { ok: false, tracked, worktree };
}

export function main(markerArg?: string): void {
  const files = readTrackedFiles();
  const result = scanTree(files);

  if (markerArg) {
    const attr = result.get(markerArg);
    if (!attr) {
      console.log(`${markerArg}: not found in the tracked tree.`);
      return;
    }
    console.log(`${attr.name}`);
    console.log(`  mentioned in (${attr.mentionedIn.length}): ${attr.mentionedIn.join(", ")}`);
    console.log(`  emitted in   (${attr.emittedIn.length}): ${attr.emittedIn.join(", ") || "(none)"}`);
    return;
  }

  const dist = { zero: 0, one: 0, several: 0 };
  for (const attr of result.values()) {
    const c = attr.emittedIn.length;
    if (c === 0) dist.zero++;
    else if (c === 1) dist.one++;
    else dist.several++;
  }
  console.log(`markerAttribution — ${result.size} distinct marker names`);
  console.log(`  emitter-count distribution: zero=${dist.zero} one=${dist.one} several=${dist.several}`);

  const hz = hazards(result);
  console.log(`  hazardous mentions (source file mentions a marker it doesn't emit, real emitter elsewhere): ${hz.length}`);
  for (const h of hz) {
    console.log(`    ${h.file}  ${h.marker}  -> ${h.emitters.join(", ")}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
