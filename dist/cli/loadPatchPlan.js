"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadPatchPlan = loadPatchPlan;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = require("node:fs");
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function assertValidPatchPlan(value) {
    if (!isObject(value)) {
        throw new Error("Patch plan must be a JSON object.");
    }
    if (!("patches" in value) || !Array.isArray(value.patches)) {
        throw new Error('Patch plan must include a "patches" array.');
    }
    for (const [index, patch] of value.patches.entries()) {
        if (!isObject(patch)) {
            throw new Error(`Patch plan patch at index ${index} must be an object.`);
        }
        if (typeof patch.filePath !== "string" || patch.filePath.trim().length === 0) {
            throw new Error(`Patch plan patch at index ${index} must include a valid filePath.`);
        }
        if (typeof patch.nextContent !== "string") {
            throw new Error(`Patch plan patch at index ${index} must include nextContent as a string.`);
        }
    }
}
function loadPatchPlan(filePath) {
    const resolvedPath = node_path_1.default.resolve(filePath);
    let raw;
    try {
        raw = (0, node_fs_1.readFileSync)(resolvedPath, "utf8");
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read patch plan: ${message}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse patch plan JSON: ${message}`);
    }
    assertValidPatchPlan(parsed);
    return parsed;
}
//# sourceMappingURL=loadPatchPlan.js.map