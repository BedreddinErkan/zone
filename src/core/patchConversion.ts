import { stripPatchTextFences } from "./developerPatchParse.js";

export type TryRecoverDeveloperPatchResult =
  | { ok: true; strictPatchText: string }
  | { ok: false; reason: string };

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function normalizeRepoPath(p: string): string {
  return normalizeNewlines(String(p || "").trim())
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

function pathsEqual(requested: string, declared: string): boolean {
  return (
    normalizeRepoPath(requested).toLowerCase() ===
    normalizeRepoPath(declared).toLowerCase()
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle.length) return 0;
  let count = 0;
  let pos = 0;
  while (pos <= haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
}

/** Split on --- FILE: lines; ignores preamble before first FILE marker. */
function extractFileBlocks(text: string): Array<{ path: string; body: string }> {
  const norm = normalizeNewlines(text);
  const lines = norm.split("\n");
  const blocks: Array<{ path: string; body: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const fileMatch = lines[i]?.match(/^---\s*FILE:\s*(.+?)(?:\s+---)?\s*$/i);
    if (!fileMatch) {
      i += 1;
      continue;
    }
    const path = fileMatch[1].trim().replace(/\s+---\s*$/i, "").trim();
    i += 1;
    const start = i;
    while (i < lines.length && !/^---\s*FILE:\s*/i.test(lines[i] ?? "")) {
      i += 1;
    }
    blocks.push({ path, body: lines.slice(start, i).join("\n") });
  }
  return blocks;
}

function findHeaderOccurrences(body: string): number {
  const m = body.match(/---\s*FIND\s*---/gi);
  return m ? m.length : 0;
}

/**
 * Tolerant FIND/REPLACE extraction (single pair only).
 */
function extractFindReplacePair(body: string): { find: string; replace: string } | null {
  const b = body.trimEnd();
  const patterns: RegExp[] = [
    /\n?---\s*FIND\s*---\s*\n([\s\S]*?)\n---\s*REPLACE\s*---\s*\n([\s\S]*)$/i,
    /^---\s*FIND\s*---\s*\n([\s\S]*?)\n---\s*REPLACE\s*---\s*\n([\s\S]*)$/i,
    /\n?---\s*FIND\s*-{2,}\s*\n([\s\S]*?)\n---\s*REPLACE\s*-{2,}\s*\n([\s\S]*)$/i,
    /\nFIND:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*)$/i,
  ];
  for (const re of patterns) {
    const m = b.match(re);
    if (!m) continue;
    const find = normalizeNewlines(m[1] ?? "");
    const replace = normalizeNewlines(m[2] ?? "");
    return { find, replace };
  }
  return null;
}

export function buildStrictDeveloperPatchText(
  filePath: string,
  find: string,
  replace: string
): string {
  const fp = normalizeRepoPath(filePath);
  return `--- FILE: ${fp} ---\n--- FIND ---\n${find}\n--- REPLACE ---\n${replace}\n`;
}

/**
 * One safe recovery pass for strict developer patch parsing failures.
 * Accepts only a single target file matching the request, a single FIND/REPLACE pair,
 * an original snippet that occurs exactly once in the file, and a non-empty edit.
 */
export function tryRecoverDeveloperPatchFromModelOutput(input: {
  requestedFilePath: string;
  originalFileContent: string;
  rawModelText: string;
}): TryRecoverDeveloperPatchResult {
  console.log("[zone-patch-recovery-start]", input.requestedFilePath);
  const raw = stripPatchTextFences(String(input.rawModelText || "")).trim();
  if (!raw) {
    console.log("[zone-patch-recovery-failed]", "empty_raw");
    return { ok: false, reason: "empty_raw" };
  }

  const original = normalizeNewlines(input.originalFileContent);
  const blocks = extractFileBlocks(raw);

  if (blocks.length > 1) {
    console.log("[zone-patch-recovery-failed]", "multiple_file_blocks");
    return { ok: false, reason: "multiple_file_blocks" };
  }

  let body: string;
  if (blocks.length === 1) {
    if (!pathsEqual(input.requestedFilePath, blocks[0].path)) {
      console.log("[zone-patch-recovery-failed]", "file_path_mismatch");
      return { ok: false, reason: "file_path_mismatch" };
    }
    body = blocks[0].body;
  } else {
    body = raw;
  }

  if (findHeaderOccurrences(body) > 1) {
    console.log("[zone-patch-recovery-failed]", "multiple_find_sections");
    return { ok: false, reason: "multiple_find_sections" };
  }

  const pair = extractFindReplacePair(body);
  if (!pair) {
    console.log("[zone-patch-recovery-failed]", "no_find_replace_pair");
    return { ok: false, reason: "no_find_replace_pair" };
  }

  const find = pair.find;
  const replace = pair.replace;
  if (!find.trim()) {
    console.log("[zone-patch-recovery-failed]", "empty_find");
    return { ok: false, reason: "empty_find" };
  }
  if (find === replace) {
    console.log("[zone-patch-recovery-failed]", "no_op_replace");
    return { ok: false, reason: "no_op_replace" };
  }

  const hits = countOccurrences(original, find);
  if (hits !== 1) {
    console.log("[zone-patch-recovery-failed]", `find_occurrences_${hits}`);
    return { ok: false, reason: `find_occurrences_${hits}` };
  }

  const idx = original.indexOf(find);
  const merged = original.slice(0, idx) + replace + original.slice(idx + find.length);
  if (merged === original) {
    console.log("[zone-patch-recovery-failed]", "merged_unchanged");
    return { ok: false, reason: "merged_unchanged" };
  }

  const strictPatchText = buildStrictDeveloperPatchText(
    input.requestedFilePath,
    find,
    replace
  );
  console.log("[zone-patch-recovery-success]", input.requestedFilePath);
  return { ok: true, strictPatchText };
}
