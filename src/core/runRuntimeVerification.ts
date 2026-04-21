import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import type { SafeVerificationCommand } from "./detectVerificationCommand.js";

export type RuntimeVerificationResult = {
  attempted: boolean;
  command?: string;
  status: "passed" | "failed" | "timeout" | "skipped";
  exitCode?: number;
  summary: string;
};

const RUNTIME_VERIFICATION_TIMEOUT_MS = 60_000;

function isAccessibleDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function summarizeOutput(stdout: string, stderr: string): string {
  const combined = [stdout, stderr].join("\n").trim();
  if (!combined) return "Command completed with no output.";
  const lines = combined.split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join("\n").slice(0, 1200);
}

export async function runRuntimeVerification(input: {
  repoPath: string;
  command: SafeVerificationCommand | null;
  timeoutMs?: number;
}): Promise<RuntimeVerificationResult> {
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

  const timeoutMs = Math.min(
    input.timeoutMs ?? RUNTIME_VERIFICATION_TIMEOUT_MS,
    RUNTIME_VERIFICATION_TIMEOUT_MS
  );

  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(input.command!.executable, input.command!.args, {
      cwd: input.repoPath,
      shell: false,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        attempted: true,
        command: input.command!.command,
        status: "timeout",
        summary: `Runtime verification timed out after ${timeoutMs / 1000}s.`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        attempted: false,
        command: input.command!.command,
        status: "skipped",
        summary: `Runtime verification could not start: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        attempted: true,
        command: input.command!.command,
        status: code === 0 ? "passed" : "failed",
        ...(typeof code === "number" ? { exitCode: code } : {}),
        summary: summarizeOutput(stdout, stderr),
      });
    });
  });
}
