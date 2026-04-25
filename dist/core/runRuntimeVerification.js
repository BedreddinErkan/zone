"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRuntimeVerification = runRuntimeVerification;
exports.runRuntimeVerificationPlan = runRuntimeVerificationPlan;
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
function looksLikeToolingFailure(message) {
    const m = message.toLowerCase();
    return (m.includes("missing script:") ||
        m.includes("no test specified") ||
        m.includes("command not found") ||
        m.includes("not recognized as an internal") ||
        m.includes("enoent") ||
        m.includes("cannot run program") ||
        m.includes("could not start") ||
        m.includes("playwright") && (m.includes("install") || m.includes("browser") || m.includes("executable doesn't exist")) ||
        m.includes("browserType.launch".toLowerCase()) ||
        m.includes("port already in use") ||
        m.includes("eaddrinuse") ||
        m.includes("cannot find module") ||
        m.includes("module not found") ||
        m.includes("missing dependency") ||
        m.includes("pnpm: command not found") ||
        m.includes("yarn: command not found") ||
        m.includes("npm err! code enoent"));
}
function trimOutput(s, maxChars = 6000) {
    const t = String(s || "");
    if (t.length <= maxChars)
        return t;
    return t.slice(-maxChars);
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
                stdout: trimOutput(stdout),
                stderr: trimOutput(stderr),
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
                stdout: trimOutput(stdout),
                stderr: trimOutput(stderr),
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
                stdout: trimOutput(stdout),
                stderr: trimOutput(stderr),
                summary: summarizeOutput(stdout, stderr),
            });
        });
    });
}
async function runRuntimeVerificationPlan(input) {
    if (input.plan.length === 0) {
        return {
            attempted: false,
            status: "skipped_no_command",
            steps: [],
            summary: "No safe verification command detected.",
        };
    }
    const steps = [];
    let attemptedAny = false;
    for (const step of input.plan) {
        const res = await runRuntimeVerification({
            repoPath: input.repoPath,
            command: step,
            timeoutMs: input.timeoutMsPerStep,
        });
        attemptedAny = attemptedAny || res.attempted;
        const combined = `${res.summary}`;
        const classifiedFailure = res.status === "failed" || (res.status === "skipped" && res.attempted === false)
            ? looksLikeToolingFailure(combined)
                ? "tooling"
                : "code"
            : undefined;
        steps.push({ ...res, kind: step.kind, classifiedFailure });
        if (res.status !== "passed") {
            // Stop at first non-pass; later steps are less useful.
            break;
        }
    }
    const firstNonPass = steps.find((s) => s.status !== "passed");
    if (!firstNonPass) {
        return {
            attempted: attemptedAny,
            status: "passed",
            steps,
            summary: "All verification steps passed.",
        };
    }
    if (firstNonPass.status === "timeout") {
        return {
            attempted: attemptedAny,
            status: "timeout",
            steps,
            failedCommand: firstNonPass.command,
            summary: firstNonPass.summary,
        };
    }
    if (firstNonPass.status === "skipped" && !attemptedAny) {
        return {
            attempted: false,
            status: "skipped_no_command",
            steps,
            failedCommand: firstNonPass.command,
            summary: firstNonPass.summary,
        };
    }
    const classified = firstNonPass.classifiedFailure ?? "code";
    return {
        attempted: attemptedAny,
        status: classified === "tooling" ? "failed_environment_or_tooling" : "failed_code_related",
        steps,
        failedCommand: firstNonPass.command,
        summary: firstNonPass.summary,
    };
}
//# sourceMappingURL=runRuntimeVerification.js.map