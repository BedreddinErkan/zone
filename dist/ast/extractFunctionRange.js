"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractFunctionRanges = extractFunctionRanges;
exports.findFunctionByName = findFunctionByName;
function splitParams(raw) {
    const r = String(raw || "").trim();
    if (!r)
        return [];
    return r
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
        // remove TS type annotations + defaults + rest
        const noType = p.replace(/:\s*[^=]+$/g, "").trim();
        const noDefault = noType.replace(/\s*=\s*.+$/g, "").trim();
        return noDefault.replace(/^\.\.\./, "").trim();
    })
        .filter(Boolean);
}
function isSkippableMethodName(name) {
    const n = name.toLowerCase();
    return (n === "if" ||
        n === "for" ||
        n === "while" ||
        n === "switch" ||
        n === "catch" ||
        n === "function" ||
        n === "return");
}
function computeLineStartOffsets(lines) {
    const offsets = [];
    let cur = 0;
    for (const line of lines) {
        offsets.push(cur);
        // We split on \n, so re-add one char for newline.
        cur += line.length + 1;
    }
    return offsets;
}
function indexOfUnescapedBraceOpen(line, fromIndex = 0) {
    const i = line.indexOf("{", fromIndex);
    return i;
}
function scanFunctionEnd(lines, startLineIndex, openBraceLineIndex, openBraceCharIndex) {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    let inBlockComment = false;
    for (let li = openBraceLineIndex; li < lines.length; li += 1) {
        const line = lines[li] ?? "";
        let i = li === openBraceLineIndex ? openBraceCharIndex : 0;
        let inLineComment = false;
        while (i < line.length) {
            const ch = line[i];
            const next = i + 1 < line.length ? line[i + 1] : "";
            if (inLineComment)
                break;
            if (inBlockComment) {
                if (ch === "*" && next === "/") {
                    inBlockComment = false;
                    i += 2;
                    continue;
                }
                i += 1;
                continue;
            }
            // Line comments.
            if (!inSingle && !inDouble && !inTemplate && ch === "/" && next === "/") {
                inLineComment = true;
                break;
            }
            // Block comments.
            if (!inSingle && !inDouble && !inTemplate && ch === "/" && next === "*") {
                inBlockComment = true;
                i += 2;
                continue;
            }
            // Strings/templates (very basic, escape-aware).
            if (!inDouble && !inTemplate && ch === "'" && line[i - 1] !== "\\") {
                inSingle = !inSingle;
                i += 1;
                continue;
            }
            if (!inSingle && !inTemplate && ch === '"' && line[i - 1] !== "\\") {
                inDouble = !inDouble;
                i += 1;
                continue;
            }
            if (!inSingle && !inDouble && ch === "`" && line[i - 1] !== "\\") {
                inTemplate = !inTemplate;
                i += 1;
                continue;
            }
            if (inSingle || inDouble || inTemplate) {
                i += 1;
                continue;
            }
            if (ch === "{") {
                depth += 1;
            }
            else if (ch === "}") {
                depth -= 1;
                if (depth === 0) {
                    return { endLineIndex: li, endCharIndex: i + 1 };
                }
            }
            i += 1;
        }
    }
    // Unbalanced braces.
    return null;
}
function extractNameFromArrowParams(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return { paramsRaw: "" };
    if (trimmed.startsWith("(") && trimmed.includes(")")) {
        return { paramsRaw: trimmed.slice(1, trimmed.indexOf(")")) };
    }
    return { paramsRaw: trimmed };
}
function extractFunctionRanges(fileContent, filePath) {
    try {
        const normalized = String(fileContent ?? "").replace(/\r\n/g, "\n");
        const lines = normalized.split("\n");
        const lineOffsets = computeLineStartOffsets(lines);
        const functions = [];
        for (let li = 0; li < lines.length; li += 1) {
            const line = lines[li] ?? "";
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (/^\s*\/\//.test(line))
                continue;
            // Named function declarations.
            // export async function foo(...)
            // export function foo(...)
            // async function foo(...)
            // function foo(...)
            const declMatch = line.match(/^\s*(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
            if (declMatch) {
                const isExported = !!declMatch[1];
                const isAsync = !!declMatch[2];
                const name = declMatch[3];
                const paramsRaw = declMatch[4] ?? "";
                // startChar must include export/async prefixes to allow safe splicing back into full file.
                const startChar = lineOffsets[li];
                const openBraceIdx = indexOfUnescapedBraceOpen(line);
                let openBraceLineIndex = li;
                let openBraceCharIndex = openBraceIdx;
                if (openBraceIdx < 0) {
                    // Look ahead for opening brace on subsequent lines.
                    let found = false;
                    for (let j = li + 1; j < Math.min(lines.length, li + 6); j += 1) {
                        const braceIdx = indexOfUnescapedBraceOpen(lines[j] ?? "");
                        if (braceIdx >= 0) {
                            openBraceLineIndex = j;
                            openBraceCharIndex = braceIdx;
                            found = true;
                            break;
                        }
                    }
                    if (!found)
                        continue;
                }
                const end = scanFunctionEnd(lines, li, openBraceLineIndex, openBraceCharIndex);
                if (!end)
                    continue;
                const endChar = lineOffsets[end.endLineIndex] + end.endCharIndex;
                const content = normalized.slice(lineOffsets[li], endChar);
                try {
                    const previewStart = Math.max(0, startChar - 20);
                    console.log("[zone-ast-range-preview]", {
                        file: filePath,
                        name,
                        startChar,
                        preview: normalized.slice(previewStart, Math.min(normalized.length, startChar + 30)),
                    });
                }
                catch { }
                functions.push({
                    name,
                    startLine: li + 1,
                    endLine: end.endLineIndex + 1,
                    startChar,
                    endChar,
                    content,
                    params: splitParams(paramsRaw),
                    isAsync,
                    isExported,
                });
                continue;
            }
            // Arrow functions assigned to const.
            // export const foo = async (...) =>
            // export const foo = (...) =>
            // const foo = async (...) =>
            // const foo = (...) =>
            const arrowMatch = line.match(/^\s*(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?(.+?)\s*=>/);
            if (arrowMatch) {
                const isExported = !!arrowMatch[1];
                const name = arrowMatch[2];
                const isAsync = !!arrowMatch[3];
                const paramsPart = arrowMatch[4] ?? "";
                const paramsRaw = extractNameFromArrowParams(paramsPart).paramsRaw;
                const startChar = lineOffsets[li] + line.indexOf(name);
                const openBraceIdx = indexOfUnescapedBraceOpen(line);
                if (openBraceIdx < 0) {
                    // Expression-bodied arrow fn: end at semicolon on same line (best effort).
                    const semi = line.indexOf(";", line.indexOf("=>"));
                    if (semi >= 0) {
                        const endChar = lineOffsets[li] + semi + 1;
                        const content = normalized.slice(lineOffsets[li], endChar);
                        functions.push({
                            name,
                            startLine: li + 1,
                            endLine: li + 1,
                            startChar,
                            endChar,
                            content,
                            params: splitParams(paramsRaw),
                            isAsync,
                            isExported,
                        });
                    }
                    continue;
                }
                const end = scanFunctionEnd(lines, li, li, openBraceIdx);
                if (!end)
                    continue;
                const endChar = lineOffsets[end.endLineIndex] + end.endCharIndex;
                const content = normalized.slice(lineOffsets[li], endChar);
                functions.push({
                    name,
                    startLine: li + 1,
                    endLine: end.endLineIndex + 1,
                    startChar,
                    endChar,
                    content,
                    params: splitParams(paramsRaw),
                    isAsync,
                    isExported,
                });
                continue;
            }
            // Method definitions (class methods).
            // async foo(...) {
            // foo(...) {
            const methodMatch = line.match(/^\s*(async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/);
            if (methodMatch) {
                const isAsync = !!methodMatch[1];
                const name = methodMatch[2];
                if (isSkippableMethodName(name))
                    continue;
                const paramsRaw = methodMatch[3] ?? "";
                const openBraceIdx = line.indexOf("{");
                if (openBraceIdx < 0)
                    continue;
                const end = scanFunctionEnd(lines, li, li, openBraceIdx);
                if (!end)
                    continue;
                const startChar = lineOffsets[li] + line.indexOf(name);
                const endChar = lineOffsets[end.endLineIndex] + end.endCharIndex;
                const content = normalized.slice(lineOffsets[li], endChar);
                functions.push({
                    name,
                    startLine: li + 1,
                    endLine: end.endLineIndex + 1,
                    startChar,
                    endChar,
                    content,
                    params: splitParams(paramsRaw),
                    isAsync,
                    isExported: false,
                });
                continue;
            }
        }
        return { ok: true, functions };
    }
    catch (err) {
        return {
            ok: false,
            functions: [],
            error: `[extractFunctionRanges] ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
function findFunctionByName(content, functionName, filePath) {
    const res = extractFunctionRanges(content, filePath);
    if (!res.ok)
        return null;
    const target = String(functionName || "").trim();
    if (!target)
        return null;
    return res.functions.find((f) => f.name === target) ?? null;
}
//# sourceMappingURL=extractFunctionRange.js.map