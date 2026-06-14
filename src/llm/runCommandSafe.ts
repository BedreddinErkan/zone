/** Command-prefix whitelist. Matched against the command after trimming. */
const WHITELIST_PREFIXES = [
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

/** Reject if ANY pattern matches the command. Blacklist takes priority over whitelist. */
const BLACKLIST_PATTERNS: RegExp[] = [
  // find write/exec action flags — block before the whitelist match can fire
  /\bfind\b.*\s(?:-delete|-exec(?:dir)?|-ok(?:dir)?|-fprint|-fprintf|-fls)\b/,
  // Mutations
  /\brm\s/,
  /\bmv\s/,
  /\bcp\s/,
  /\btouch\s/,
  /\bmkdir\s/,
  /\bchmod\s/,
  /\bchown\s/,
  // Redirects / pipes-to-write
  />\s*(?:[^&\s\/]|\/(?!dev\/null(?:\s|$)))/,  // block write redirects to real files; allow /dev/null sinks and fd merges (2>&1)
  />>\s*\S/,
  /\btee\s/,
  // Package mutations
  /\bnpm\s+(install|i|update|uninstall|remove)\b/,
  /\byarn\s+(add|remove|install)\b/,
  /\bpnpm\s+(add|remove|install|update)\b/,
  /\bpip\s+install\b/,
  /\bcargo\s+install\b/,
  // Git injection vectors: block before the git-read whitelist can fire.
  // -c key=val: arbitrary command execution via diff.external, core.pager, etc.
  /\bgit\s+-c\s/,
  // --exec-path=: loads executables from an arbitrary path
  /\bgit\b.*\s--exec-path=/,
  // --upload-pack: network-facing, runs an arbitrary program
  /\bgit\b.*\s--upload-pack\b/,
  // --ext-diff: external diff driver → arbitrary command execution
  /\bgit\b.*\s--ext-diff\b/,
  // git diff --output=: writes the diff to a file instead of stdout
  /\bgit\s+diff\b.*\s--output=/,
  // Git mutations
  /\bgit\s+(push|pull|fetch|commit|merge|rebase|reset\s+--hard|checkout\s+-\s)/,
  // Git branch mutations (prefix "git branch" is in the whitelist, so block destructive flags explicitly)
  /\bgit\s+branch\s+(-[dDmMcCu]|--delete\b|--move\b|--copy\b|--set-upstream)/,
  // Network mutations
  /\bcurl\s+.*-X\s*(POST|PUT|DELETE|PATCH)/i,
  /\bwget\s/,
  /\bnc\s/,
  // Shell substitution — backticks and $(...) bypass the prefix check
  /`/,
  /\$\(/,
  // Chain operators — single command only
  /;\s*\S/,
  /&&\s*\S/,
  /\|\|\s*\S/,
  // sort -o/-output writes to a file without '>'; block it independently of the redirect guard
  /\bsort\b[^|]*(\s-o(\s|=|$)|--output)/,
  // Privilege escalation
  /\bsudo\b/,
  /\bsu\b/,
  /\bdoas\b/,
  // Process kill
  /\bkill\s/,
  /\bpkill\s/,
  /\bkillall\s/,
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

export interface CommandSafetyResult {
  safe: boolean;
  reason?: string;
}

export function checkCommandSafe(command: string): CommandSafetyResult {
  const trimmed = command.trim();
  if (!trimmed) return { safe: false, reason: "empty command" };

  // Blacklist takes priority over whitelist.
  for (const pattern of BLACKLIST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { safe: false, reason: `blocked pattern: ${pattern.source}` };
    }
  }

  // Quote/escape-aware pipe check: block real pipes to non-read-only utilities.
  // Runs after the blacklist so the || guard and substitution guards fire first.
  if (hasUnsafeRealPipe(trimmed)) {
    return { safe: false, reason: "pipe to non-whitelisted command" };
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
    };
  }

  return { safe: true };
}
