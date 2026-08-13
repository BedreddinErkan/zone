/** Command-prefix whitelist. Matched against the command after trimming. */
export const WHITELIST_PREFIXES = [
  // Test runners
  "npx vitest",
  "vitest",
  "npm test",
  "npm run test",
  "pnpm test",
  "yarn test",
  "jest",
  "pytest",
  "python -m pytest",
  // Type/lint checks
  "tsc",
  "npx tsc",
  // Same shape as "npm run test" above: a project-defined script body, trusted
  // by convention on its name. Without it a read-only run can typecheck only by
  // spelling it `tsc --noEmit`, while every repo's own docs say the alias.
  "npm run typecheck",
  "npm run lint",
  "eslint",
  "npx eslint",
  "prettier --check",
  // Builds (report-only flags)
  "go test",
  "go vet",
  "cargo check",
  "cargo test --no-run",
  // Read-only git / shell inspection
  "git log",
  "git diff",
  "git status",
  "git show",
  "git branch",
  "git blame",
  "git rev-parse",
  "git ls-files",
  "git grep",
  "git cat-file",
  "git rev-list",
  "git describe",
  "git shortlog",
  "git ls-tree",
  // Read filesystem
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find",   // any path; write/exec-capable find flags blocked by blacklist below
  "grep",
  "rg",
  "fd",
  "pwd",
  "which",
] as const;

/**
 * Item 93 fix: every rejection reason belongs to one of 19 classes, carried alongside the
 * pattern that produces it (or assigned inline for the three non-pattern-driven causes) so
 * the consumer can select a human-language message by class instead of substring-sniffing
 * the regex-bearing `reason` string. `chain` and `whitelist-miss` route to their own
 * dedicated, already-human-language variants (A and B) — see `CatchAllClass` below for the
 * 17 that reach the shared catch-all (variant C).
 */
export type RejectionClass =
  | "find-write-exec"
  | "fd-exec"
  | "rg-preprocessor"
  | "file-mutation"
  | "write-redirect"
  | "tee"
  | "package-mutation"
  | "git-injection"
  | "git-mutation"
  | "git-branch-mutation"
  | "network-mutation"
  | "shell-substitution"
  | "chain"
  | "sort-o"
  | "privilege-escalation"
  | "process-kill"
  | "pipe-to-non-utility"
  | "empty-command"
  | "whitelist-miss";

/** The 17 classes that reach the shared catch-all (variant C) — everything except the two
 *  classes with their own dedicated variant (`chain` → A, `whitelist-miss` → B). */
export type CatchAllClass = Exclude<RejectionClass, "chain" | "whitelist-miss">;

/** Reject if ANY pattern matches the command. Blacklist takes priority over whitelist.
 *  Order is load-bearing (first match wins) — do not reorder without re-checking every
 *  command whose verdict depends on an earlier pattern firing first. */
const BLACKLIST_PATTERNS: { pattern: RegExp; tag: RejectionClass }[] = [
  // find write/exec action flags — block before the whitelist match can fire
  { pattern: /\bfind\b.*\s(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint|-fprintf|-fls)\b/, tag: "find-write-exec" },
  // fd exec flags — anchored to command start (fd is NOT a PIPE_READ_UTIL so it only runs as
  // the head command; anchoring prevents false-positives like "ls fd -x" or "grep fd.txt -x foo")
  { pattern: /^\s*fd\b.*\s(?:-[xX]|--exec(?:-batch)?)(?:\s|$|=)/, tag: "fd-exec" },
  // rg pre-processor flags — UNANCHORED because rg IS a PIPE_READ_UTIL and must be caught
  // mid-pipeline (e.g. "cat file.txt | rg --pre ./evil.sh pattern")
  { pattern: /\brg\b.*\s--pre(?:-glob)?(?:\s|$|=)/, tag: "rg-preprocessor" },
  // Mutations
  { pattern: /\brm\s/, tag: "file-mutation" },
  { pattern: /\bmv\s/, tag: "file-mutation" },
  { pattern: /\bcp\s/, tag: "file-mutation" },
  { pattern: /\btouch\s/, tag: "file-mutation" },
  { pattern: /\bmkdir\s/, tag: "file-mutation" },
  { pattern: /\bchmod\s/, tag: "file-mutation" },
  { pattern: /\bchown\s/, tag: "file-mutation" },
  // Redirects / pipes-to-write
  // block write redirects to real files; allow /dev/null sinks and fd merges (2>&1)
  { pattern: />\s*(?:[^&\s\/]|\/(?!dev\/null(?:\s|$)))/, tag: "write-redirect" },
  // >> is a strict subset of the > pattern above (always fires first) — kept as its own
  // entry for clarity, but unreachable on its own; shares write-redirect's tag deliberately.
  { pattern: />>\s*\S/, tag: "write-redirect" },
  { pattern: /\btee\s/, tag: "tee" },
  // Package mutations
  { pattern: /\bnpm\s+(install|i|update|uninstall|remove)\b/, tag: "package-mutation" },
  { pattern: /\byarn\s+(add|remove|install)\b/, tag: "package-mutation" },
  { pattern: /\bpnpm\s+(add|remove|install|update)\b/, tag: "package-mutation" },
  { pattern: /\bpip\s+install\b/, tag: "package-mutation" },
  { pattern: /\bcargo\s+install\b/, tag: "package-mutation" },
  // Git injection vectors: block before the git-read whitelist can fire.
  // -c key=val: arbitrary command execution via diff.external, core.pager, etc.
  { pattern: /\bgit\s+-c\s/, tag: "git-injection" },
  // --exec-path=: loads executables from an arbitrary path
  { pattern: /\bgit\b.*\s--exec-path=/, tag: "git-injection" },
  // --upload-pack: network-facing, runs an arbitrary program
  { pattern: /\bgit\b.*\s--upload-pack\b/, tag: "git-injection" },
  // --ext-diff: external diff driver → arbitrary command execution
  { pattern: /\bgit\b.*\s--ext-diff\b/, tag: "git-injection" },
  // git diff --output=: writes the diff to a file instead of stdout
  { pattern: /\bgit\s+diff\b.*\s--output=/, tag: "git-injection" },
  // Git mutations
  { pattern: /\bgit\s+(push|pull|fetch|commit|merge|rebase|reset\s+--hard|checkout\s+-\s)/, tag: "git-mutation" },
  // Git branch mutations (prefix "git branch" is in the whitelist, so block destructive flags explicitly)
  { pattern: /\bgit\s+branch\s+(-[dDmMcCu]|--delete\b|--move\b|--copy\b|--set-upstream)/, tag: "git-branch-mutation" },
  // Network mutations
  { pattern: /\bcurl\s+.*-X\s*(POST|PUT|DELETE|PATCH)/i, tag: "network-mutation" },
  { pattern: /\bwget\s/, tag: "network-mutation" },
  { pattern: /\bnc\s/, tag: "network-mutation" },
  // Shell substitution — backticks and $(...) bypass the prefix check
  { pattern: /`/, tag: "shell-substitution" },
  { pattern: /\$\(/, tag: "shell-substitution" },
  // Chain operators — single command only
  { pattern: /;\s*\S/, tag: "chain" },
  { pattern: /&&\s*\S/, tag: "chain" },
  { pattern: /\|\|\s*\S/, tag: "chain" },
  // sort -o/-output writes to a file without '>'; block it independently of the redirect guard
  { pattern: /\bsort\b[^|]*(\s-o(\s|=|$)|--output)/, tag: "sort-o" },
  // Privilege escalation
  { pattern: /\bsudo\b/, tag: "privilege-escalation" },
  { pattern: /\bsu\b/, tag: "privilege-escalation" },
  { pattern: /\bdoas\b/, tag: "privilege-escalation" },
  // Process kill
  { pattern: /\bkill\s/, tag: "process-kill" },
  { pattern: /\bpkill\s/, tag: "process-kill" },
  { pattern: /\bkillall\s/, tag: "process-kill" },
];

const PIPE_READ_UTILS = new Set([
  "head","tail","grep","rg","wc","less","more","cat","jq","sort","uniq","cut","column",
]);

/**
 * Split a shell command on REAL pipe operators: unquoted, unescaped single '|' (not '||',
 * not inside single/double quotes, not preceded by a backslash).
 * Quoting model: single quotes are fully literal; double quotes honor backslash-escapes;
 * outside quotes a backslash escapes the next character. '||' is treated as a single token
 * (not a pipe boundary) so the existing line-82 logical-OR guard owns it.
 */
function splitOnRealShellPipes(cmd: string): string[] {
  const segments: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (quote === '"' && c === "\\") { cur += c + (cmd[i + 1] ?? ""); i++; continue; }
      if (c === quote) { quote = null; cur += c; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\") { cur += c + (cmd[i + 1] ?? ""); i++; continue; } // \| is literal data
    if (c === "|") {
      if (cmd[i + 1] === "|") { cur += "||"; i++; continue; } // logical OR — not a split
      segments.push(cur); cur = ""; continue;                 // real pipe boundary
    }
    cur += c;
  }
  segments.push(cur);
  return segments;
}

/** True iff cmd contains a real pipe whose downstream first word is not a read-only utility. */
function hasUnsafeRealPipe(cmd: string): boolean {
  const segs = splitOnRealShellPipes(cmd);
  if (segs.length === 1) return false;
  for (let k = 1; k < segs.length; k++) {
    const first = (segs[k].trim().match(/^(\S+)/)?.[1] ?? "");
    if (!PIPE_READ_UTILS.has(first)) return true; // empty (trailing pipe) or non-util → block
  }
  return false;
}

/**
 * Item 93 fix: discriminated union on `safe`, not an optional `tag?`. A rejection path that
 * forgot to set `tag` under an optional field would silently reach the consumer's message
 * lookup as `undefined` — the discriminated union makes the compiler reject any `safe: false`
 * return missing `tag`, at every rejection return site below. `reason` is unchanged in shape
 * and, for every existing input, unchanged in value.
 */
export type CommandSafetyResult =
  | { safe: true }
  | { safe: false; reason: string; tag: RejectionClass };

export function checkCommandSafe(command: string): CommandSafetyResult {
  const trimmed = command.trim();
  if (!trimmed) return { safe: false, reason: "empty command", tag: "empty-command" };

  // Blacklist takes priority over whitelist.
  for (const { pattern, tag } of BLACKLIST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason: `blocked pattern: ${pattern.source}`, tag };
    }
  }

  // Quote/escape-aware pipe check: block real pipes to non-read-only utilities.
  // Runs after the blacklist so the || guard and substitution guards fire first.
  if (hasUnsafeRealPipe(trimmed)) {
    return { safe: false, reason: "pipe to non-whitelisted command", tag: "pipe-to-non-utility" };
  }

  // Command must START WITH one of the whitelisted prefixes.
  const matched = WHITELIST_PREFIXES.some(
    (prefix) =>
      trimmed === prefix ||
      trimmed.startsWith(prefix + " ") ||
      trimmed.startsWith(prefix + "\t")
  );

  if (!matched) {
    const sample = (WHITELIST_PREFIXES as readonly string[]).slice(0, 8).join(", ");
    return {
      safe: false,
      reason: `not in whitelist. Allowed prefixes: ${sample}, ...`,
      tag: "whitelist-miss",
    };
  }

  return { safe: true };
}
