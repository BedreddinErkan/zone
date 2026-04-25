"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildStrictDeveloperPatchText = buildStrictDeveloperPatchText;
exports.tryRecoverDeveloperPatchFromModelOutput = tryRecoverDeveloperPatchFromModelOutput;
const developerPatchParse_js_1 = require("./developerPatchParse.js");
function normalizeNewlines(s) {
    return s.replace(/\r\n/g, "\n");
}
function collapseSpaces(s) {
    return s.replace(/[ \t]+/g, " ");
}
function normalizeTrailingComma(line) {
    return line.replace(/,\s*$/, "");
}
function normalizeLineForMatch(line) {
    return normalizeTrailingComma(collapseSpaces(String(line || "").trim()));
}
function normalizeTextForMatch(text) {
    const norm = normalizeNewlines(String(text || ""));
    return norm
        .split("\n")
        .map((l) => normalizeLineForMatch(l))
        .join("\n")
        .trim();
}
function estimateChangedLines(find, replace) {
    const a = normalizeNewlines(find).split("\n");
    const b = normalizeNewlines(replace).split("\n");
    const max = Math.max(a.length, b.length);
    let diffs = Math.abs(a.length - b.length);
    const min = Math.min(a.length, b.length);
    for (let i = 0; i < min; i += 1) {
        if ((a[i] ?? "") !== (b[i] ?? ""))
            diffs += 1;
    }
    return Math.min(diffs, max);
}
function deriveSingleLineEdit(find, replace) {
    const a = normalizeNewlines(find).split("\n");
    const b = normalizeNewlines(replace).split("\n");
    const min = Math.min(a.length, b.length);
    const diffs = [];
    for (let i = 0; i < min; i += 1) {
        const aa = (a[i] ?? "").trimEnd();
        const bb = (b[i] ?? "").trimEnd();
        if (aa !== bb)
            diffs.push({ a: aa, b: bb });
    }
    // Only support 1-line substitutions (same line count).
    if (a.length !== b.length)
        return null;
    if (diffs.length !== 1)
        return null;
    const d = diffs[0];
    if (!d)
        return null;
    return { findLine: d.a, replaceLine: d.b };
}
function findBestFuzzyWindowMatch(input) {
    const originalLinesRaw = normalizeNewlines(input.original).split("\n");
    const originalLinesNorm = originalLinesRaw.map((l) => normalizeLineForMatch(l));
    const findLinesNorm = normalizeNewlines(input.find)
        .split("\n")
        .map((l) => normalizeLineForMatch(l))
        .filter((l) => l.length > 0);
    if (findLinesNorm.length === 0) {
        return { ok: false, reason: "empty_find_lines" };
    }
    const first = findLinesNorm[0] ?? "";
    const second = findLinesNorm[1] ?? "";
    const startAt = input.anchorLineRange?.start ?? 0;
    const endAt = input.anchorLineRange?.end ?? Math.max(0, originalLinesNorm.length - 1);
    const windowLen = Math.min(findLinesNorm.length, 12);
    const scan = (requireSecondLine) => {
        const candidates = [];
        for (let i = startAt; i <= endAt; i += 1) {
            if ((originalLinesNorm[i] ?? "") !== first)
                continue;
            if (requireSecondLine && second && (originalLinesNorm[i + 1] ?? "") !== second) {
                continue;
            }
            let matches = 0;
            for (let j = 0; j < windowLen; j += 1) {
                const o = originalLinesNorm[i + j] ?? "";
                const f = findLinesNorm[j] ?? "";
                if (f && o === f)
                    matches += 1;
            }
            const score = matches / windowLen;
            candidates.push({ startLine: i, score });
        }
        return candidates;
    };
    // Prefer anchoring on first 2 lines if possible; otherwise fall back to first line only.
    let candidates = scan(true);
    if (candidates.length === 0) {
        candidates = scan(false);
    }
    if (candidates.length === 0) {
        return { ok: false, reason: "no_candidates" };
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const secondBest = candidates[1];
    if (!best)
        return { ok: false, reason: "no_best" };
    if (best.score < 0.8)
        return { ok: false, reason: `low_score_${best.score.toFixed(2)}` };
    if (secondBest && Math.abs(best.score - secondBest.score) < 0.05) {
        return { ok: false, reason: "ambiguous_best_match" };
    }
    return { ok: true, startLine: best.startLine, lineCount: windowLen, score: best.score };
}
function normalizeRepoPath(p) {
    return normalizeNewlines(String(p || "").trim())
        .replace(/\\/g, "/")
        .replace(/^\.?\//, "");
}
function pathsEqual(requested, declared) {
    return (normalizeRepoPath(requested).toLowerCase() ===
        normalizeRepoPath(declared).toLowerCase());
}
function countOccurrences(haystack, needle) {
    if (!needle.length)
        return 0;
    let count = 0;
    let pos = 0;
    while (pos <= haystack.length) {
        const idx = haystack.indexOf(needle, pos);
        if (idx === -1)
            break;
        count += 1;
        pos = idx + needle.length;
    }
    return count;
}
/** Split on --- FILE: lines; ignores preamble before first FILE marker. */
function extractFileBlocks(text) {
    const norm = normalizeNewlines(text);
    const lines = norm.split("\n");
    const blocks = [];
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
function findHeaderOccurrences(body) {
    const m = body.match(/---\s*FIND\s*---/gi);
    return m ? m.length : 0;
}
/**
 * Tolerant FIND/REPLACE extraction (single pair only).
 */
function extractFindReplacePair(body) {
    const b = body.trimEnd();
    const patterns = [
        /\n?---\s*FIND\s*---\s*\n([\s\S]*?)\n---\s*REPLACE\s*---\s*\n([\s\S]*)$/i,
        /^---\s*FIND\s*---\s*\n([\s\S]*?)\n---\s*REPLACE\s*---\s*\n([\s\S]*)$/i,
        /\n?---\s*FIND\s*-{2,}\s*\n([\s\S]*?)\n---\s*REPLACE\s*-{2,}\s*\n([\s\S]*)$/i,
        /\nFIND:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*)$/i,
    ];
    for (const re of patterns) {
        const m = b.match(re);
        if (!m)
            continue;
        const find = normalizeNewlines(m[1] ?? "");
        const replace = normalizeNewlines(m[2] ?? "");
        return { find, replace };
    }
    return null;
}
function buildStrictDeveloperPatchText(filePath, find, replace) {
    const fp = normalizeRepoPath(filePath);
    return `--- FILE: ${fp} ---\n--- FIND ---\n${find}\n--- REPLACE ---\n${replace}\n`;
}
/**
 * One safe recovery pass for strict developer patch parsing failures.
 * Accepts only a single target file matching the request, a single FIND/REPLACE pair,
 * an original snippet that occurs exactly once in the file, and a non-empty edit.
 */
function tryRecoverDeveloperPatchFromModelOutput(input) {
    console.log("[zone-patch-recovery-start]", input.requestedFilePath);
    const raw = (0, developerPatchParse_js_1.stripPatchTextFences)(String(input.rawModelText || "")).trim();
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
    let body;
    if (blocks.length === 1) {
        if (!pathsEqual(input.requestedFilePath, blocks[0].path)) {
            console.log("[zone-patch-recovery-failed]", "file_path_mismatch");
            return { ok: false, reason: "file_path_mismatch" };
        }
        body = blocks[0].body;
    }
    else {
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
    const patchChangedLines = estimateChangedLines(find, replace);
    if (patchChangedLines > 5) {
        console.log("[zone-patch-recovery-failed]", "edit_too_large");
        return { ok: false, reason: "edit_too_large" };
    }
    let resolvedFind = find;
    let resolvedReplace = replace;
    const hits = countOccurrences(original, find);
    if (hits !== 1) {
        // Minimal patch mode: allow a very small, single-line removal even if FIND is off.
        const taskNorm = String(input.task || "").toLowerCase();
        const minimalPatchMode = taskNorm.includes("remove stray character") && patchChangedLines <= 1;
        if (minimalPatchMode) {
            const findLines = normalizeNewlines(find).split("\n").map((l) => l.trimEnd());
            const replaceLines = new Set(normalizeNewlines(replace).split("\n").map((l) => l.trimEnd()));
            const removed = findLines.filter((l) => l.trim() && !replaceLines.has(l));
            if (removed.length === 1) {
                const tokenLine = removed[0] ?? "";
                // Try removing the exact raw line (with trailing newline if present).
                const withNl = `${tokenLine}\n`;
                const tokenHits = countOccurrences(original, withNl) || countOccurrences(original, tokenLine);
                if (tokenHits === 1) {
                    console.log("[zone-patch-fallback-applied]", "minimal_patch_ignore_find");
                    resolvedFind = countOccurrences(original, withNl) === 1 ? withNl : tokenLine;
                    resolvedReplace = "";
                }
            }
        }
        // If still unresolved, attempt fuzzy/heuristic match with normalization.
        if (countOccurrences(original, resolvedFind) !== 1) {
            // Prefer safe 1-line edits when the model patch is effectively a micro change.
            const singleLine = deriveSingleLineEdit(find, replace);
            if (singleLine && patchChangedLines <= 1) {
                const originalLinesRaw = normalizeNewlines(original).split("\n");
                const matchingIdxs = [];
                const want = normalizeLineForMatch(singleLine.findLine);
                for (let i = 0; i < originalLinesRaw.length; i += 1) {
                    if (normalizeLineForMatch(originalLinesRaw[i] ?? "") === want) {
                        matchingIdxs.push(i);
                    }
                }
                if (matchingIdxs.length === 1) {
                    const idx = matchingIdxs[0] ?? 0;
                    const rawLine = originalLinesRaw[idx] ?? "";
                    const indent = (rawLine.match(/^\s*/)?.[0] ?? "");
                    const replaceNoIndent = singleLine.replaceLine.replace(/^\s*/, "");
                    resolvedFind = rawLine;
                    resolvedReplace = `${indent}${replaceNoIndent}`;
                    console.log("[zone-patch-fuzzy-match]", JSON.stringify({
                        filePath: input.requestedFilePath,
                        mode: "single_line_normalized",
                        line: idx + 1,
                    }));
                    console.log("[zone-patch-fallback-applied]", "single_line_normalized");
                }
                else if (matchingIdxs.length > 1) {
                    console.log("[zone-patch-recovery-failed]", "single_line_ambiguous");
                    return { ok: false, reason: "single_line_ambiguous" };
                }
            }
            const fuzzy = findBestFuzzyWindowMatch({ original, find });
            if (fuzzy.ok) {
                console.log("[zone-patch-fuzzy-match]", JSON.stringify({
                    filePath: input.requestedFilePath,
                    startLine: fuzzy.startLine,
                    lineCount: fuzzy.lineCount,
                    score: fuzzy.score,
                }));
                const originalLinesRaw = normalizeNewlines(original).split("\n");
                const candidate = originalLinesRaw
                    .slice(fuzzy.startLine, fuzzy.startLine + fuzzy.lineCount)
                    .join("\n");
                if (countOccurrences(original, candidate) === 1) {
                    resolvedFind = candidate;
                    console.log("[zone-patch-fallback-applied]", "fuzzy_window");
                }
                else {
                    console.log("[zone-patch-recovery-failed]", "fuzzy_ambiguous");
                    return { ok: false, reason: "fuzzy_ambiguous" };
                }
            }
            else {
                const fnMatch = find.match(/\b(?:export\s+default\s+function|function)\s+([A-Za-z0-9_]+)\b/);
                const fnName = fnMatch?.[1];
                if (fnName) {
                    const originalLinesRaw = normalizeNewlines(original).split("\n");
                    const originalLinesNorm = originalLinesRaw.map((l) => normalizeLineForMatch(l));
                    const anchorIdxs = [];
                    for (let i = 0; i < originalLinesNorm.length; i += 1) {
                        if (originalLinesNorm[i]?.includes(`function ${fnName}`)) {
                            anchorIdxs.push(i);
                        }
                    }
                    if (anchorIdxs.length === 1) {
                        const anchor = anchorIdxs[0] ?? 0;
                        const start = Math.max(0, anchor - 80);
                        const end = Math.min(originalLinesRaw.length - 1, anchor + 80);
                        const heur = findBestFuzzyWindowMatch({
                            original,
                            find,
                            anchorLineRange: { start, end },
                        });
                        if (heur.ok) {
                            console.log("[zone-patch-heuristic-match]", JSON.stringify({
                                filePath: input.requestedFilePath,
                                functionName: fnName,
                                startLine: heur.startLine,
                                lineCount: heur.lineCount,
                                score: heur.score,
                            }));
                            const candidate = originalLinesRaw
                                .slice(heur.startLine, heur.startLine + heur.lineCount)
                                .join("\n");
                            if (countOccurrences(original, candidate) === 1) {
                                resolvedFind = candidate;
                                console.log("[zone-patch-fallback-applied]", "heuristic_function_anchor");
                            }
                            else {
                                console.log("[zone-patch-recovery-failed]", "heuristic_ambiguous");
                                return { ok: false, reason: "heuristic_ambiguous" };
                            }
                        }
                    }
                }
            }
        }
        const finalHits = countOccurrences(original, resolvedFind);
        if (finalHits !== 1) {
            if (finalHits === 0) {
                console.log("[zone-patch-no-match-abort]", JSON.stringify({
                    filePath: input.requestedFilePath,
                    reason: "recovery_find_not_found",
                }));
                return { ok: false, reason: "no_match_abort" };
            }
            console.log("[zone-patch-recovery-failed]", `find_occurrences_${finalHits}`);
            return { ok: false, reason: `find_occurrences_${finalHits}` };
        }
    }
    const idx = original.indexOf(resolvedFind);
    const merged = original.slice(0, idx) +
        resolvedReplace +
        original.slice(idx + resolvedFind.length);
    if (merged === original) {
        console.log("[zone-patch-recovery-failed]", "merged_unchanged");
        return { ok: false, reason: "merged_unchanged" };
    }
    const strictPatchText = buildStrictDeveloperPatchText(input.requestedFilePath, resolvedFind, resolvedReplace);
    console.log("[zone-patch-recovery-success]", input.requestedFilePath);
    return { ok: true, strictPatchText };
}
//# sourceMappingURL=patchConversion.js.map