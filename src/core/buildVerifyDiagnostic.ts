import {
  parseVerificationError,
  type VerificationErrorInfo,
} from "./parseVerificationError.js";

/**
 * agent-persistence Tur: structured diagnostic prelude for the agent's
 * coaching message after a failed run_command. Pulls together everything
 * `parseVerificationError` already extracts (failingFile, line, errorType,
 * affectedFiles) plus a "framework-generated path" indicator and a
 * candidate-culprit list, then formats it as a Markdown block the agent
 * can act on.
 *
 * Pure module — no I/O. Inputs come from agentLoop's per-iteration state.
 */

const GENERATED_PATH_PREFIXES = [
  ".next/",
  "dist/",
  "build/",
  "out/",
  ".svelte-kit/",
  ".nuxt/",
];

export function detectGeneratedPath(
  filePath: string | null | undefined
): boolean {
  if (filePath == null) return false;
  const normalized = String(filePath)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
  if (!normalized) return false;
  return GENERATED_PATH_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix)
  );
}

export interface VerifyDiagnosticInput {
  failedToolOutput: string;
  filesModified: string[];
  /** Full repo file list (used to score candidate culprits). Empty array
   *  is acceptable — the diagnostic still works, just without candidates. */
  filesInRepo: string[];
  framework?:
    | { framework?: string; language?: string }
    | null
    | undefined;
  attemptCount: number;
}

export interface VerifyDiagnostic {
  /** Markdown-ish prelude to inject above the coaching text. */
  text: string;
  /** True when the parsed failing file lives under .next/, dist/, etc. */
  generatedPathDetected: boolean;
  /** Output of parseVerificationError for the same input — exposed so the
   *  caller can reuse failingFile / failingLine for log telemetry without
   *  re-parsing. Null when the parser couldn't find a failing file at all. */
  parsed: VerificationErrorInfo | null;
  /** Candidate culprit paths (top of the score-ordered list). Empty when no
   *  generated path detected, or filesInRepo was empty. */
  candidates: string[];
}

const MAX_CANDIDATES_LISTED = 8;
const MAX_CANDIDATES_COMPUTED = 24;

function selectCandidateCulprits(
  filesInRepo: string[],
  filesModified: string[]
): string[] {
  if (!Array.isArray(filesInRepo) || filesInRepo.length === 0) {
    // Even without repo file list, recently-modified files are still
    // useful candidates — they're the most likely cause.
    return [...filesModified];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  // Highest-leverage first: files the agent already touched this run.
  for (const f of filesModified) {
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  // Then framework-shaped suspects: layouts, providers, root entries.
  // Match `.[jt]sx?` extensions on layout/provider/root files. Conservative
  // pattern — won't over-flag arbitrary `provider` substrings in URLs etc.
  const pattern = /(?:^|\/)(layout|page|root)\.(?:[jt]sx?)$|provider[a-z]*\.(?:[jt]sx?)$|\b[A-Z][A-Za-z0-9]*Provider\.(?:[jt]sx?)$/i;
  for (const f of filesInRepo) {
    if (!f || seen.has(f)) continue;
    if (f.startsWith("node_modules/") || f.includes("/node_modules/")) continue;
    if (detectGeneratedPath(f)) continue;
    if (!pattern.test(f)) continue;
    seen.add(f);
    out.push(f);
    if (out.length >= MAX_CANDIDATES_COMPUTED) break;
  }
  return out;
}

export function buildVerifyDiagnostic(
  input: VerifyDiagnosticInput
): VerifyDiagnostic {
  const parsed = parseVerificationError(
    String(input.failedToolOutput ?? ""),
    Array.isArray(input.filesModified) ? input.filesModified : []
  );
  // Treat parsed as null when nothing was extractable — gives callers a
  // simple null-check rather than poking at empty fields.
  const parsedHasSignal =
    !!parsed.failingFile ||
    parsed.errorType !== "unknown" ||
    (parsed.affectedFiles?.length ?? 0) > 0;
  const parsedOut = parsedHasSignal ? parsed : null;

  const generatedPathDetected = detectGeneratedPath(parsed.failingFile);

  const candidates = generatedPathDetected
    ? selectCandidateCulprits(input.filesInRepo ?? [], input.filesModified ?? [])
    : [];

  const lines: string[] = [];
  lines.push(`## Build/test diagnostic (attempt ${input.attemptCount})`);
  lines.push("");

  if (parsed.failingFile) {
    const lineSuffix = parsed.failingLine ? ` line ${parsed.failingLine}` : "";
    lines.push(`**Failing file (parsed)**: \`${parsed.failingFile}\`${lineSuffix}`);
  } else {
    lines.push(`**Failing file**: not extractable from the raw output`);
  }
  if (parsed.errorType && parsed.errorType !== "unknown") {
    lines.push(`**Error type**: ${parsed.errorType}`);
  }
  if (parsed.errorMessage && parsed.errorMessage.trim().length > 0) {
    lines.push(`**Error message**: ${parsed.errorMessage.slice(0, 200)}`);
  }

  if (generatedPathDetected) {
    lines.push("");
    lines.push(
      "**⚠ Generated-path indicator**: This failure points to a framework-generated file (`.next/`, `dist/`, `build/`, `out/`, `.svelte-kit/`, `.nuxt/`). Generated files are downstream of YOUR source — the actual cause is in user-source files. Common patterns:"
    );
    lines.push(
      "- Next.js `/_global-error` or `/_not-found` errors → check `app/layout.tsx` and the provider chain (`components/*Provider*.tsx`)."
    );
    lines.push(
      `- \`useContext\` / \`useEffect\` null → a server component is rendering a client-only hook → add \`"use client";\` directive at the top of the offending component.`
    );
    lines.push("- `Module not found` in generated output → check imports in your user-source files.");

    if (candidates.length > 0) {
      lines.push("");
      lines.push(
        "**Candidate culprit files** (read these BEFORE making any verdict):"
      );
      for (const c of candidates.slice(0, MAX_CANDIDATES_LISTED)) {
        lines.push(`- \`${c}\``);
      }
      if (candidates.length > MAX_CANDIDATES_LISTED) {
        lines.push(`- … and ${candidates.length - MAX_CANDIDATES_LISTED} more`);
      }
    }
  }

  if (input.filesModified && input.filesModified.length > 0) {
    lines.push("");
    lines.push(
      `**Files you modified this run**: ${input.filesModified.slice(0, 10).join(", ")}`
    );
  }

  return {
    text: lines.join("\n"),
    generatedPathDetected,
    parsed: parsedOut,
    candidates,
  };
}
