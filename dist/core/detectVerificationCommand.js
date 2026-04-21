"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectVerificationCommand = detectVerificationCommand;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
function hasRepoFile(repoFiles, fileName) {
    return repoFiles.some((filePath) => filePath.replace(/\\/g, "/") === fileName);
}
function readRepoText(repoPath, fileName) {
    const path = (0, node_path_1.join)(repoPath, fileName);
    if (!(0, node_fs_1.existsSync)(path))
        return "";
    try {
        return (0, node_fs_1.readFileSync)(path, "utf8");
    }
    catch {
        return "";
    }
}
function getNpmExecutable() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
}
function getPytestExecutable() {
    return process.platform === "win32" ? "pytest.exe" : "pytest";
}
function hasPytestSignals(repoPath, repoFiles) {
    if (hasRepoFile(repoFiles, "pytest.ini") ||
        repoFiles.some((filePath) => /(^|\/)(test|tests|__tests__)\//i.test(filePath)) ||
        repoFiles.some((filePath) => /\.(test|spec)\.py$/i.test(filePath))) {
        return true;
    }
    const requirements = readRepoText(repoPath, "requirements.txt");
    if (/\bpytest\b/i.test(requirements))
        return true;
    const pyproject = readRepoText(repoPath, "pyproject.toml");
    return /\bpytest\b/i.test(pyproject);
}
function detectVerificationCommand(input) {
    if (hasRepoFile(input.repoFiles, "package.json")) {
        const packageJson = readRepoText(input.repoPath, "package.json");
        try {
            const parsed = JSON.parse(packageJson);
            const scripts = parsed.scripts ?? {};
            if (typeof scripts.test === "string" && scripts.test.trim()) {
                return {
                    command: "npm test",
                    executable: getNpmExecutable(),
                    args: ["test"],
                };
            }
            if (typeof scripts.build === "string" && scripts.build.trim()) {
                return {
                    command: "npm run build",
                    executable: getNpmExecutable(),
                    args: ["run", "build"],
                };
            }
        }
        catch {
            return null;
        }
    }
    if (hasPytestSignals(input.repoPath, input.repoFiles)) {
        return {
            command: "pytest -q",
            executable: getPytestExecutable(),
            args: ["-q"],
        };
    }
    return null;
}
//# sourceMappingURL=detectVerificationCommand.js.map