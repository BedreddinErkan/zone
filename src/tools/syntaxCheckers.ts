/**
 * W.1–W.3: SYNTAX_CHECKERS table.
 *
 * Single source of truth for per-language inline syntax validation.
 * W.1: TS entry (behaviour-identical refactor of the former hard-coded path).
 * W.2: Python entry (py_compile, first-class).
 * W.3: Go (gofmt), Ruby (ruby -c), Java (javac) — experimental, env-gated.
 *
 * Experimental checkers only activate when their id appears in the
 * ZONE_EXPERIMENTAL_SYNTAX_CHECKERS env var (CSV, e.g. "go,ruby,java").
 * Omitting the var (default) leaves only first-class checkers active.
 */

import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export type ParsedSyntaxError = {
  line?: number;
  col?: number;
  code?: string;
  message: string;
};

export type SyntaxChecker = {
  id: string;
  extensions: string[];
  status: "first-class" | "beta" | "experimental";
  /** Build the shell command + args to run on a temp file. Args should be
   *  shell-ready (quote the filepath when the checker needs it). */
  cmdTemplate: (filepath: string) => { cmd: string; args: string[] };
  /** Cached per-process. Returns true when the checker binary is available.
   *  repoPath is forwarded so probes can check project-local node_modules. */
  availabilityCheck: (repoPath?: string) => Promise<boolean>;
  /** True when at least one error in the list should block the patch. */
  isBlockingError: (errors: ParsedSyntaxError[]) => boolean;
  /** Extract structured errors from raw checker output. */
  parseErrors: (stdout: string, stderr: string, exitCode: number) => ParsedSyntaxError[];
  /** Max ms before the checker process is killed and the patch is approved. */
  timeoutMs: number;
  /** When true, checker unavailable on PATH → silently approve (do not block). */
  gracefulSkip: boolean;
};

// ---------------------------------------------------------------------------
// Availability cache — keyed by binary name, value is a settled Promise so
// repeated calls in the same process skip the `which` spawn.
// ---------------------------------------------------------------------------
const availabilityCache = new Map<string, Promise<boolean>>();

/** Clear the availability cache — test helper only. */
export function clearAvailabilityCache(): void {
  availabilityCache.clear();
}

export function whichCheck(binary: string): Promise<boolean> {
  if (!availabilityCache.has(binary)) {
    // Pass an options object so promisify(exec) calls exec(cmd, opts, cb)
    // rather than exec(cmd, cb) — the 3-arg form is the canonical shape.
    availabilityCache.set(
      binary,
      execAsync(`which ${binary}`, { timeout: 5_000 })
        .then(() => true)
        .catch(() => false),
    );
  }
  return availabilityCache.get(binary)!;
}

// ---------------------------------------------------------------------------
// tsc availability probe — deterministic fs check before any exec.
// ---------------------------------------------------------------------------

// Test override: when set, probeTscAvailable returns this value directly.
let _tscAvailabilityOverride: (() => Promise<boolean>) | null = null;

/** Override the tsc probe result in tests. Pass null to restore real probe. */
export function _setTscAvailabilityForTest(fn: (() => Promise<boolean>) | null): void {
  _tscAvailabilityOverride = fn;
}

/**
 * Returns true when tsc is resolvable for the given project.
 * Checks project-local node_modules/.bin/tsc first (the common case —
 * typescript in devDependencies), then falls back to PATH.
 * Using repoPath avoids false "not installed" warnings when Zone is launched
 * from a directory other than the project root.
 */
export async function probeTscAvailable(repoPath?: string): Promise<boolean> {
  if (_tscAvailabilityOverride) return _tscAvailabilityOverride();
  const localTsc = path.join(repoPath ?? process.cwd(), "node_modules", ".bin", "tsc");
  if (fs.existsSync(localTsc)) return true;
  try {
    await execAsync("which tsc", { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// One-time unavailability warning tracker (per process / per session).
// Follows the webSearchWarning.ts pattern.
// ---------------------------------------------------------------------------
const _unavailableWarned = new Set<string>();

/**
 * Records that checker `id` has been warned as unavailable.
 * Returns true the first time for a given id; false on subsequent calls.
 */
export function trackCheckerUnavailableWarning(id: string): boolean {
  if (_unavailableWarned.has(id)) return false;
  _unavailableWarned.add(id);
  return true;
}

/** Reset all unavailability warnings — test helper only. */
export function _resetCheckerWarningsForTest(): void {
  _unavailableWarned.clear();
}

// ---------------------------------------------------------------------------
// SYNTAX_CHECKERS table
// ---------------------------------------------------------------------------

export const SYNTAX_CHECKERS: SyntaxChecker[] = [
  {
    id: "ts",
    extensions: [".ts", ".tsx", ".cts", ".mts"],
    status: "first-class",
    cmdTemplate: (fp) => ({
      cmd: "npx",
      // NOTE: --module ESNext is intentionally permissive — repo tsconfig uses
      // Node16, but Node16 enforces explicit .js extensions on relative imports,
      // which generates TS2xxx noise on single-file checks. ESNext + bundler is
      // the "permissive but realistic" pairing for inline syntax verification.
      // Do not change to match repo tsconfig. See Phase I audit 2026-05-19 Lane 0.D.
      //
      // --no-install: prevents npx from downloading typescript when it's absent;
      // probeTscAvailable() gates the exec so this is belt-and-suspenders.
      args: [
        "--no-install",
        "tsc",
        "--noEmit",
        "--module",
        "ESNext",
        "--moduleResolution",
        "bundler",
        "--target",
        "es2022",
        "--skipLibCheck",
        `"${fp}"`,
      ],
    }),
    // Real probe: checks node_modules/.bin/tsc (project-local) then PATH.
    // When absent, toolExecutor emits a one-time warning and approves (gracefulSkip).
    availabilityCheck: (repoPath?: string) => probeTscAvailable(repoPath),
    // Only TS1xxx (syntax errors) block the patch; TS2xxx (semantic /
    // cross-file errors) are approved because single-file context cannot
    // resolve imports.
    isBlockingError: (errors) =>
      errors.some((e) => /^TS1\d{3}$/.test(e.code ?? "")),
    parseErrors: (stdout, _stderr, _exitCode) => {
      // Extract every TSxxxx code present in stdout. isBlockingError then
      // filters to TS1xxx. parseTscErrorPreview (applyRollbackFeedback.ts)
      // is still used for the rich rollback message — this lightweight
      // extraction is only for the blocking decision.
      const matches = stdout.match(/\bTS\d{4}\b/g) ?? [];
      return [...new Set(matches)].map((code) => ({ code, message: code }));
    },
    timeoutMs: 5000,
    // Matches current silent-approve behavior when tsc/npx is missing.
    gracefulSkip: true,
  },
  {
    id: "py",
    extensions: [".py"],
    status: "first-class",
    cmdTemplate: (fp) => ({ cmd: "python3", args: ["-m", "py_compile", fp] }),
    availabilityCheck: () => whichCheck("python3"),
    // Any parsed error from py_compile is a syntax error — always block.
    isBlockingError: (errors) => errors.length > 0,
    parseErrors: (_stdout, stderr, _exitCode) => {
      const out: ParsedSyntaxError[] = [];
      const fileLineMatch = stderr.match(/File "([^"]+)", line (\d+)/);
      const errorMatch = stderr.match(/^(SyntaxError|IndentationError|TabError): (.+)$/m);
      if (errorMatch) {
        out.push({
          line: fileLineMatch ? parseInt(fileLineMatch[2], 10) : undefined,
          code: errorMatch[1],
          message: errorMatch[2],
        });
      }
      return out;
    },
    timeoutMs: 5000,
    gracefulSkip: true,
  },
  // ---------------------------------------------------------------------------
  // W.3 — experimental checkers (env-gated via ZONE_EXPERIMENTAL_SYNTAX_CHECKERS)
  // ---------------------------------------------------------------------------
  {
    id: "go",
    extensions: [".go"],
    status: "experimental",
    // gofmt -e parses to AST; errors go to stderr, exit 0 even on bad input.
    // Non-zero exit indicates a fatal parse error; stderr carries the detail.
    cmdTemplate: (fp) => ({ cmd: "gofmt", args: ["-e", fp] }),
    availabilityCheck: () => whichCheck("gofmt"),
    isBlockingError: (errors) => errors.length > 0,
    parseErrors: (_stdout, stderr, _exitCode) => {
      // gofmt -e stderr format: <file>:<line>:<col>: <message>
      const out: ParsedSyntaxError[] = [];
      const re = /^.+:(\d+):(\d+):\s*(.+)$/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr)) !== null) {
        out.push({ line: parseInt(m[1], 10), col: parseInt(m[2], 10), message: m[3] });
      }
      return out;
    },
    timeoutMs: 5000,
    gracefulSkip: true,
  },
  {
    id: "rb",
    extensions: [".rb"],
    status: "experimental",
    // ruby -c parses without execution; success → "Syntax OK" on stdout; error → stderr
    cmdTemplate: (fp) => ({ cmd: "ruby", args: ["-c", fp] }),
    availabilityCheck: () => whichCheck("ruby"),
    isBlockingError: (errors) => errors.length > 0,
    parseErrors: (_stdout, stderr, _exitCode) => {
      // ruby -c error format: <file>:<line>: <message> (SyntaxError)
      const out: ParsedSyntaxError[] = [];
      const m = stderr.match(/^.+:(\d+):\s*(.+?)\s*\(SyntaxError\)$/m);
      if (m) {
        out.push({ line: parseInt(m[1], 10), code: "SyntaxError", message: m[2] });
      }
      return out;
    },
    timeoutMs: 5000,
    gracefulSkip: true,
  },
  {
    id: "java",
    extensions: [".java"],
    status: "experimental",
    // javac -d /tmp prevents .class output in the repo; -Xlint:none narrows to errors
    cmdTemplate: (fp) => ({ cmd: "javac", args: ["-d", "/tmp/zone-javac-out", "-Xlint:none", fp] }),
    availabilityCheck: () => whichCheck("javac"),
    isBlockingError: (errors) => errors.length > 0,
    parseErrors: (_stdout, stderr, _exitCode) => {
      // javac error format: <file>:<line>: error: <message>
      const out: ParsedSyntaxError[] = [];
      const re = /^.+:(\d+):\s*error:\s*(.+)$/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stderr)) !== null) {
        out.push({ line: parseInt(m[1], 10), message: m[2] });
      }
      return out;
    },
    timeoutMs: 10000,
    gracefulSkip: true,
  },
];

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

export function findCheckerForFile(filepath: string): SyntaxChecker | null {
  const ext = path.extname(filepath).toLowerCase();
  const checker = SYNTAX_CHECKERS.find((c) => c.extensions.includes(ext));
  if (!checker) return null;

  // Experimental checkers require opt-in via ZONE_EXPERIMENTAL_SYNTAX_CHECKERS
  if (checker.status === "experimental") {
    const csv = process.env.ZONE_EXPERIMENTAL_SYNTAX_CHECKERS ?? "";
    const enabled = csv.split(",").map((s) => s.trim()).filter(Boolean);
    if (!enabled.includes(checker.id)) return null;
  }

  return checker;
}
