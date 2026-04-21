"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRuntimeVerification = runRuntimeVerification;
const node_fs_1 = require("node:fs");
const node_child_process_1 = require("node:child_process");
const RUNTIME_VERIFICATION_TIMEOUT_MS = 60_000;
function isAccessibleDirectory(path) {
    try {
        return (0, node_fs_1.existsSync)(path) && (0, node_fs_1.statSync)(path).isDirectory();
    }
    catch {
        return false;
    }
}
function summarizeOutput(stdout, stderr) {
    const combined = [stdout, stderr].join("\n").trim();
    if (!combined)
        return "Command completed with no output.";
    const lines = combined.split(/\r?\n/).filter(Boolean);
    return lines.slice(-8).join("\n").slice(0, 1200);
}
async function runRuntimeVerification(input) {
    if (!input.command) {
        return {
            attempted: false,
            status: "skipped",
            summary: "No safe verification command detected.",
        };
    }
    if (!isAccessibleDirectory(input.repoPath)) {
        return {
            attempted: false,
            command: input.command.command,
            status: "skipped",
            summary: "Repository path is not accessible for runtime verification.",
        };
    }
    const timeoutMs = Math.min(input.timeoutMs ?? RUNTIME_VERIFICATION_TIMEOUT_MS, RUNTIME_VERIFICATION_TIMEOUT_MS);
    return new Promise((resolve) => {
        let settled = false;
        let stdout = "";
        let stderr = "";
        const child = (0, node_child_process_1.spawn)(input.command.executable, input.command.args, {
            cwd: input.repoPath,
            shell: false,
            windowsHide: true,
        });
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill();
            resolve({
                attempted: true,
                command: input.command.command,
                status: "timeout",
                summary: `Runtime verification timed out after ${timeoutMs / 1000}s.`,
            });
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({
                attempted: false,
                command: input.command.command,
                status: "skipped",
                summary: `Runtime verification could not start: ${err.message}`,
            });
        });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({
                attempted: true,
                command: input.command.command,
                status: code === 0 ? "passed" : "failed",
                ...(typeof code === "number" ? { exitCode: code } : {}),
                summary: summarizeOutput(stdout, stderr),
            });
        });
    });
}
//# sourceMappingURL=runRuntimeVerification.js.map