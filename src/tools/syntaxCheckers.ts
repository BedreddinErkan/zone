/**
 * W.1/W.2: SYNTAX_CHECKERS table.
 *
 * Single source of truth for per-language inline syntax validation.
 * W.1: TS entry (behaviour-identical refactor of the former hard-coded path).
 * W.2: Python entry (py_compile, first-class).
 * W.3 (future): Go/Ruby/Java experimental entries.
 */

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
  /** Cached per-process. Returns true when the checker binary is available. */
  availabilityCheck: () => Promise<boolean>;
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
// SYNTAX_CHECKERS table
// ---------------------------------------------------------------------------

export const SYNTAX_CHECKERS: SyntaxChecker[] = [
  {
    id: "ts",
    extensions: [".ts", ".tsx", ".cts", ".mts"],
    status: "first-class",
    cmdTemplate: (fp) => ({
      cmd: "npx",
      // Last arg is already quoted so the joined shell string matches the
      // former hard-coded invocation exactly.
      args: [
        "tsc",
        "--noEmit",
        "--moduleResolution",
        "bundler",
        "--target",
        "es2022",
        "--skipLibCheck",
        `"${fp}"`,
      ],
    }),
    // Always available: the former code never pre-checked for tsc — it ran
    // `npx tsc` and silently approved on any error (ENOENT included).
    // gracefulSkip:true preserves that behaviour when npx/tsc is absent.
    // W.2/W.3 entries will use whichCheck("python3") / whichCheck("gofmt") etc.
    availabilityCheck: () => Promise.resolve(true),
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
];

// ---------------------------------------------------------------------------
// Lookup helper
// ---------------------------------------------------------------------------

export function findCheckerForFile(filepath: string): SyntaxChecker | null {
  const ext = path.extname(filepath).toLowerCase();
  return SYNTAX_CHECKERS.find((c) => c.extensions.includes(ext)) ?? null;
}
