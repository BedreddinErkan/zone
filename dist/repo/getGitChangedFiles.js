"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGitChangedFiles = getGitChangedFiles;
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_util_1 = require("node:util");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
function normalizeGitPath(filePath) {
    return filePath.replace(/\\/g, "/").trim();
}
async function runGit(cwd, args) {
    const { stdout } = await execFileAsync("git", args, {
        cwd,
        windowsHide: true
    });
    return stdout
        .split("\n")
        .map((line) => normalizeGitPath(line))
        .filter(Boolean);
}
async function getMergeBaseBranch(targetPath) {
    const candidates = ["origin/main", "origin/master", "main", "master"];
    for (const candidate of candidates) {
        try {
            await execFileAsync("git", ["rev-parse", "--verify", candidate], {
                cwd: targetPath,
                windowsHide: true
            });
            return candidate;
        }
        catch {
            // try next
        }
    }
    return null;
}
async function getGitChangedFiles(targetPath) {
    try {
        const repoRootResult = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
            cwd: targetPath,
            windowsHide: true
        });
        const repoRoot = repoRootResult.stdout.trim();
        if (!repoRoot) {
            return [];
        }
        const relativeBase = node_path_1.default.relative(repoRoot, targetPath).replace(/\\/g, "/");
        const baseBranch = await getMergeBaseBranch(repoRoot);
        let changedFiles = [];
        if (baseBranch) {
            try {
                changedFiles = await runGit(repoRoot, [
                    "diff",
                    "--name-only",
                    `${baseBranch}...HEAD`
                ]);
            }
            catch {
                changedFiles = [];
            }
        }
        if (changedFiles.length === 0) {
            try {
                const statusResult = await execFileAsync("git", ["status", "--short"], {
                    cwd: repoRoot,
                    windowsHide: true
                });
                changedFiles = statusResult.stdout
                    .split("\n")
                    .map((line) => line.replace(/\\/g, "/"))
                    .map((line) => line.slice(3).trim())
                    .filter(Boolean);
            }
            catch {
                changedFiles = [];
            }
        }
        if (!relativeBase || relativeBase === "") {
            return [...new Set(changedFiles)];
        }
        return [
            ...new Set(changedFiles
                .filter((filePath) => filePath === relativeBase || filePath.startsWith(`${relativeBase}/`))
                .map((filePath) => filePath.startsWith(`${relativeBase}/`)
                ? filePath.slice(relativeBase.length + 1)
                : node_path_1.default.basename(filePath)))
        ];
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=getGitChangedFiles.js.map