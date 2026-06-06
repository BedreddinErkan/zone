/** Derive a concise git commit subject from a stripped patchPreview. */
export function deriveCommitMessage(stripped: string): string {
  for (const line of stripped.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("##") || trimmed.startsWith("---")) continue;
    // Strip leading bullet/dash markers
    let clean = trimmed.replace(/^[-*]\s+/, "").trim();
    // Strip backticks only — they're decoration (code spans) never part of identifiers.
    // Do NOT strip * or _ — they appear in snake_case names, filenames, globs, **kwargs, etc.
    clean = clean.replace(/`/g, "").trim();
    if (!clean) continue;
    if (clean.length <= 72) return clean;
    // Word-boundary trim: find last space at or before index 72
    const cut = clean.lastIndexOf(" ", 72);
    return cut > 0 ? clean.slice(0, cut) : clean.slice(0, 72);
  }
  return "Run completed";
}

/** Gate for commitOnSuccess auto-commit: all three conditions must hold. */
export function shouldAutoCommit(
  runResult: { ok?: boolean; fileDiffs?: Array<{ filePath: string }> } | undefined,
  commitOnSuccess: boolean
): boolean {
  return !!runResult?.ok && (runResult.fileDiffs?.length ?? 0) > 0 && commitOnSuccess;
}
