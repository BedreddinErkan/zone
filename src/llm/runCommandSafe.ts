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
  // Read filesystem
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "find . -name",
  "find . -type",
  "grep",
  "rg",
  "fd",
] as const;

/** Reject if ANY pattern matches the command. Blacklist takes priority over whitelist. */
const BLACKLIST_PATTERNS: RegExp[] = [
  // Mutations
  /\brm\s/,
  /\bmv\s/,
  /\bcp\s/,
  /\btouch\s/,
  /\bmkdir\s/,
  /\bchmod\s/,
  /\bchown\s/,
  // Redirects / pipes-to-write
  />\s*\S/,
  />>\s*\S/,
  /\btee\s/,
  // Package mutations
  /\bnpm\s+(install|i|update|uninstall|remove)\b/,
  /\byarn\s+(add|remove|install)\b/,
  /\bpnpm\s+(add|remove|install|update)\b/,
  /\bpip\s+install\b/,
  /\bcargo\s+install\b/,
  // Git mutations
  /\bgit\s+(push|pull|fetch|commit|merge|rebase|reset\s+--hard|checkout\s+-\s)/,
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
  // Pipe to anything other than safe read utilities.
  // The whitespace is inside the lookahead to prevent zero-width matches at the space before the utility name.
  /\|(?!\s*(?:head|tail|grep|rg|wc|less|more|cat|jq)(?:\s|$))/,
  // Privilege escalation
  /\bsudo\b/,
  /\bsu\b/,
  /\bdoas\b/,
  // Process kill
  /\bkill\s/,
  /\bpkill\s/,
  /\bkillall\s/,
];

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
