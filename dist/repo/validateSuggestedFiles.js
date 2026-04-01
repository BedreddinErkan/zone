"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateSuggestedFiles = validateSuggestedFiles;
const node_path_1 = __importDefault(require("node:path"));
function normalize(value) {
    return value.replace(/\\/g, "/").toLowerCase();
}
function findExactMatch(files, suggestedPath) {
    const normalizedSuggested = normalize(suggestedPath);
    return files.find((file) => normalize(file.path) === normalizedSuggested);
}
function findLooseMatch(files, suggestedPath) {
    const normalizedSuggested = normalize(suggestedPath);
    const suggestedBaseName = node_path_1.default.basename(normalizedSuggested);
    let match = files.find((file) => node_path_1.default.basename(normalize(file.path)) === suggestedBaseName);
    if (match) {
        return match;
    }
    const simplifiedSuggested = normalizedSuggested
        .replace("/controllers/", "/")
        .replace("/routes/", "/")
        .replace("/services/", "/");
    match = files.find((file) => {
        const candidate = normalize(file.path)
            .replace("/controllers/", "/")
            .replace("/routes/", "/")
            .replace("/services/", "/");
        return candidate === simplifiedSuggested;
    });
    return match;
}
function validateSuggestedFiles(suggestedFiles, repoFiles) {
    return suggestedFiles.map((item) => {
        const exactMatch = findExactMatch(repoFiles, item.path);
        if (exactMatch) {
            return {
                originalPath: item.path,
                resolvedPath: exactMatch.path,
                action: item.action,
                reason: item.reason,
                status: "verified"
            };
        }
        const looseMatch = findLooseMatch(repoFiles, item.path);
        if (looseMatch) {
            return {
                originalPath: item.path,
                resolvedPath: looseMatch.path,
                action: item.action,
                reason: item.reason,
                status: "corrected"
            };
        }
        return {
            originalPath: item.path,
            resolvedPath: null,
            action: item.action,
            reason: item.reason,
            status: "missing"
        };
    });
}
//# sourceMappingURL=validateSuggestedFiles.js.map