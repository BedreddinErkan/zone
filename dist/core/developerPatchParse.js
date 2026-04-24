"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripPatchTextFences = stripPatchTextFences;
exports.parseFindReplacePatch = parseFindReplacePatch;
exports.parseDeveloperPatchText = parseDeveloperPatchText;
function stripPatchTextFences(rawPatchText) {
    let t = rawPatchText.trim();
    t = t.replace(/^```(?:json|text|txt|patch|diff)?\s*\n?/i, "");
    t = t.replace(/\n?```\s*$/i, "");
    return t.trim();
}
function parseFindReplacePatch(rawPatchText) {
    const match = rawPatchText.match(/--- FIND ---\s*\n([\s\S]*?)\n--- REPLACE ---\s*\n([\s\S]*)$/i);
    if (!match) {
        return null;
    }
    return {
        find: match[1],
        replace: match[2],
    };
}
function parseDeveloperPatchText(rawPatchText) {
    const normalizedPatchText = stripPatchTextFences(rawPatchText);
    if (normalizedPatchText === "NO_CHANGE_NEEDED") {
        return {
            filePath: "",
            edits: [],
            noChangeNeeded: true,
        };
    }
    if (normalizedPatchText === "NO_VALID_PATCH") {
        return null;
    }
    const barePatch = parseFindReplacePatch(normalizedPatchText);
    if (barePatch) {
        return {
            filePath: "",
            edits: [barePatch],
        };
    }
    const fileLineMatch = normalizedPatchText.match(/^---\s*FILE:\s*([^\n\r]+)\s*\r?\n([\s\S]*)$/im);
    const fileLegacyMatch = normalizedPatchText.match(/^---\s*FILE:\s*(.+?)\s*---\s*([\s\S]*)$/im);
    const match = fileLineMatch ?? fileLegacyMatch;
    if (!match) {
        return null;
    }
    let body = match[2].trim();
    body = body.replace(/^```diff\s*\n/i, "").replace(/\n```\s*$/i, "").trim();
    const filePath = match[1].trim().replace(/\s+---\s*$/, "").trim();
    const bareInBody = parseFindReplacePatch(body);
    if (bareInBody) {
        return {
            filePath,
            edits: [bareInBody],
        };
    }
    const createMatch = body.match(/^CREATE:\s*\n?([\s\S]*)$/i);
    if (createMatch) {
        return {
            filePath,
            edits: [],
            createContent: createMatch[1],
        };
    }
    const edits = [];
    const editRegex = /FIND:\s*\n([\s\S]*?)\nREPLACE:\s*\n([\s\S]*?)(?=\nFIND:\s*\n|$)/gi;
    let editMatch = null;
    while ((editMatch = editRegex.exec(body)) !== null) {
        edits.push({
            find: editMatch[1],
            replace: editMatch[2],
        });
    }
    return edits.length > 0 ? { filePath, edits } : null;
}
//# sourceMappingURL=developerPatchParse.js.map