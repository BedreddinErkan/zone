"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyLlmPatches = applyLlmPatches;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
async function applyLlmPatches(patches, repoPath) {
    const PROTECTED_PATHS = ["src/ui/index.html", "src/ui/"];
    const applied = [];
    const skipped = [];
    const failed = [];
    const resolvedRepo = node_path_1.default.resolve(repoPath);
    for (const patch of patches) {
        if (patch.fullContent === "") {
            skipped.push(patch.filePath);
            continue;
        }
        if (PROTECTED_PATHS.some((p) => patch.filePath.startsWith(p))) {
            failed.push(patch.filePath);
            continue;
        }
        const absolutePath = node_path_1.default.resolve(repoPath, patch.filePath);
        try {
            await node_fs_1.promises.access(resolvedRepo);
            const isInsideRepo = absolutePath.startsWith(resolvedRepo + node_path_1.default.sep) ||
                absolutePath === resolvedRepo;
            if (!isInsideRepo) {
                throw new Error("Path outside repo");
            }
            const parentDir = node_path_1.default.dirname(absolutePath);
            await node_fs_1.promises.mkdir(parentDir, { recursive: true });
            await node_fs_1.promises.writeFile(absolutePath, patch.fullContent, "utf8");
            applied.push(patch.filePath);
        }
        catch {
            failed.push(patch.filePath);
        }
    }
    return { applied, skipped, failed };
}
//# sourceMappingURL=applyLlmPatches.js.map