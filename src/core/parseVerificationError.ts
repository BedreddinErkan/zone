export interface VerificationErrorInfo {
  failingFile: string | null; // e.g. "client/tests/home.spec.js"
  failingLine: number | null; // e.g. 17
  errorType:
    | "no_tests_found"
    | "assertion_error"
    | "syntax_error"
    | "runtime_error"
    | "unknown";
  errorMessage: string; // clean human-readable error
  isToolingIssue: boolean; // true if test runner itself is broken
  isPreExisting: boolean; // true if unrelated to our change
  affectedFiles: string[]; // all files mentioned in stack trace
}

function normPath(p: string): string {
  return String(p || "").replace(/\\/g, "/").replace(/^\s+|\s+$/g, "");
}

function looksLikeStructuralOrTooling(textLower: string): boolean {
  return (
    textLower.includes("no tests found") ||
    textLower.includes("no test files") ||
    textLower.includes("could not find tests") ||
    textLower.includes("missing script:") ||
    textLower.includes("command not found") ||
    textLower.includes("not recognized as an internal") ||
    textLower.includes("enoent") ||
    textLower.includes("eaddrinuse") ||
    textLower.includes("port already in use") ||
    textLower.includes("could not start") ||
    textLower.includes("cannot find module") ||
    textLower.includes("module not found") ||
    textLower.includes("playwright") && (textLower.includes("install") || textLower.includes("browser"))
  );
}

function extractAllFileMentions(summary: string): string[] {
  const s = String(summary || "").replace(/\r\n/g, "\n");
  const hits = new Set<string>();

  // Windows paths like C:\...\file.ts:12:3 or C:/.../file.ts:12:3
  const winRe = /([A-Za-z]:[\\/][^\s()]+?\.(?:ts|tsx|js|jsx))(?:\:(\d+))?(?:\:(\d+))?/g;
  for (const m of s.matchAll(winRe)) {
    if (m[1]) hits.add(normPath(m[1]));
  }

  // POSIX-ish paths like src/foo/bar.ts:12:3
  const posixRe = /((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx))(?:\:(\d+))?(?:\:(\d+))?/g;
  for (const m of s.matchAll(posixRe)) {
    if (m[1]) hits.add(normPath(m[1]));
  }

  return Array.from(hits);
}

function isNodeModulesPath(p: string): boolean {
  return normPath(p).toLowerCase().includes("/node_modules/");
}

function pickFailingFileAndLine(summary: string): { file: string | null; line: number | null } {
  const s = String(summary || "").replace(/\r\n/g, "\n");

  // Collect path:line candidates in order of appearance.
  // Stack traces often have: at ... (C:\path\file.js:17:6)
  const candidates: Array<{ file: string; line: number | null }> = [];
  const atRe = /\(([^()]+?\.(?:ts|tsx|js|jsx))\:(\d+)\:(\d+)\)/g;
  for (const m of s.matchAll(atRe)) {
    if (!m?.[1]) continue;
    candidates.push({ file: normPath(m[1]), line: Number(m[2] || "") || null });
  }

  // Also handle bare: file.js:17:6 (including absolute win paths)
  const fileReGlobal =
    /([A-Za-z]:[\\/][^\s:()]+?\.(?:ts|tsx|js|jsx)|(?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx))\:(\d+)(?:\:(\d+))?/g;
  for (const m of s.matchAll(fileReGlobal)) {
    if (!m?.[1]) continue;
    candidates.push({ file: normPath(m[1]), line: Number(m[2] || "") || null });
  }

  // Prefer the first non-node_modules path in the message.
  const firstUser = candidates.find((c) => c.file && !isNodeModulesPath(c.file)) ?? null;
  if (firstUser) return { file: firstUser.file, line: firstUser.line };

  // Fall back to first candidate (even if it's a library file).
  if (candidates.length > 0) {
    return { file: candidates[0]!.file, line: candidates[0]!.line };
  }

  return { file: null, line: null };
}

function classifyErrorType(textLower: string): VerificationErrorInfo["errorType"] {
  if (
    textLower.includes("no tests found") ||
    textLower.includes("no test files") ||
    textLower.includes("could not find tests")
  ) {
    return "no_tests_found";
  }
  if (textLower.includes("syntaxerror") || textLower.includes("unexpected token")) {
    return "syntax_error";
  }
  if (textLower.includes("assertionerror") || textLower.includes("expect(")) {
    return "assertion_error";
  }
  if (
    textLower.includes("cannot find module") ||
    textLower.includes("module_not_found") ||
    textLower.includes("referenceerror") ||
    textLower.includes("typeerror")
  ) {
    return "runtime_error";
  }
  return "unknown";
}

function cleanMessage(summary: string): string {
  const s = String(summary || "").replace(/\r\n/g, "\n").trim();
  if (!s) return "Verification failed.";
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  // Keep first non-empty line + maybe 2 more, capped.
  return lines.slice(0, 3).join("\n").slice(0, 600);
}

function parseVerificationErrorImpl(
  failureSummary: string,
  patchedFiles: string[],
  repoPath?: string
): VerificationErrorInfo {
  const raw = String(failureSummary || "");
  const lower = raw.toLowerCase();
  const errorType = classifyErrorType(lower);
  const { file: failingFileRaw, line: failingLine } = pickFailingFileAndLine(raw);
  const affectedFiles = extractAllFileMentions(raw);

  const patchedSet = new Set((patchedFiles || []).map(normPath));
  const failingFromStack = failingFileRaw ? normPath(failingFileRaw) : null;
  const affectedNorm = affectedFiles.map(normPath);
  const repoNorm = repoPath ? normPath(repoPath).replace(/\/+$/g, "") : "";
  const isInsideRepo = (p: string): boolean => {
    if (!p) return false;
    const n = normPath(p);
    if (!repoNorm) return false;
    // Accept absolute repo-local paths like C:/repo/... (or already-normalized).
    return n.toLowerCase().startsWith((repoNorm + "/").toLowerCase());
  };

  // Prefer affectedFiles[0] when it points to a repo-local absolute file.
  const firstAffected = affectedNorm.length > 0 ? affectedNorm[0] : null;
  const firstRepoLocalAffected =
    firstAffected && isInsideRepo(firstAffected) ? firstAffected : null;
  // Otherwise, pick the first repo-local file mentioned anywhere in affectedFiles.
  const anyRepoLocalAffected =
    affectedNorm.find((p) => p && isInsideRepo(p)) ?? null;
  // Next best: any non-node_modules file (relative paths etc.)
  const firstUserFileFromAffected =
    affectedNorm.find((p) => p && !isNodeModulesPath(p)) ?? null;

  // Prefer repo-local affected file over stack when stack is in node_modules OR absent.
  const preferredAffected =
    firstRepoLocalAffected ?? anyRepoLocalAffected ?? firstUserFileFromAffected;
  const failingFile =
    failingFromStack == null
      ? preferredAffected
      : isNodeModulesPath(failingFromStack)
        ? preferredAffected
        : failingFromStack;

  const isToolingIssue =
    errorType === "no_tests_found" || looksLikeStructuralOrTooling(lower);

  const failingFileIsPatched =
    failingFile != null &&
    (patchedSet.has(failingFile) ||
      // Allow suffix match when stack shows absolute path
      Array.from(patchedSet).some((p) => failingFile.endsWith(p)));

  // "no tests found" is often a pre-existing suite/config issue, but if we can attribute it to
  // a specific failing file, we can attempt to fix that file instead of skipping outright.
  const isPreExisting =
    (errorType === "no_tests_found" && failingFile == null) ||
    (failingFile != null && isNodeModulesPath(failingFile)) ||
    (!failingFileIsPatched && looksLikeStructuralOrTooling(lower));

  return {
    failingFile,
    failingLine,
    errorType,
    errorMessage: cleanMessage(raw),
    isToolingIssue,
    isPreExisting,
    affectedFiles,
  };
}

export function parseVerificationError(
  failureSummary: string,
  patchedFiles: string[]
): VerificationErrorInfo {
  return parseVerificationErrorImpl(failureSummary, patchedFiles);
}

export function parseVerificationErrorWithRepo(
  failureSummary: string,
  patchedFiles: string[],
  repoPath?: string
): VerificationErrorInfo {
  return parseVerificationErrorImpl(failureSummary, patchedFiles, repoPath);
}

