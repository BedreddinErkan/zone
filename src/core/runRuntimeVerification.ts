import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import type { SafeVerificationCommand, SafeVerificationStep } from "./detectVerificationCommand.js";
import { sanitizeVerificationEnv, strippedEnvKeys } from "./buildEnv.js";

export type RuntimeVerificationResult = {
  attempted: boolean;
  command?: string;
  status: "passed" | "failed" | "timeout" | "skipped";
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  summary: string;
};

export type VerificationStatus =
  | "passed"
  | "failed_code_related"
  | "failed_environment_or_tooling"
  | "skipped_no_command"
  | "timeout";

export type RuntimeVerificationPlanResult = {
  attempted: boolean;
  status: VerificationStatus;
  steps: Array<
    RuntimeVerificationResult & {
      kind?: SafeVerificationStep["kind"];
      classifiedFailure?: "code" | "tooling";
    }
  >;
  failedCommand?: string;
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

function buildFailureSummary(stdout: string, stderr: string): string {
  const out = trimOutput(stdout, 12_000).trim();
  const err = trimOutput(stderr, 12_000).trim();
  const combined = [out, err].filter(Boolean).join("\n\n");
  if (!combined) return "Command failed with no output.";
  return combined;
}

function looksLikeToolingFailure(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("missing script:") ||
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
    m.includes("npm err! code enoent")
  );
}

function trimOutput(s: string, maxChars = 6000): string {
  const t = String(s || "");
  if (t.length <= maxChars) return t;
  return t.slice(-maxChars);
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
      // Windows: spawn('npm', [...]) without a shell often fails with EINVAL;
      // npm is a cmd/shim that expects shell invocation.
      shell: true,
      windowsHide: true,
      env: sanitizeVerificationEnv(),
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      console.log(
        `[zone-verify] cmd="${input.command!.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=124 stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
      );
      resolve({
        attempted: true,
        command: input.command!.command,
        status: "timeout",
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
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
      console.log(
        `[zone-verify] cmd="${input.command!.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=1 stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
      );
      resolve({
        attempted: false,
        command: input.command!.command,
        status: "skipped",
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        summary: `Runtime verification could not start: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = code === 0 ? "passed" : "failed";
      const exitCode = typeof code === "number" ? code : 1;
      console.log(
        `[zone-verify] cmd="${input.command!.command.slice(0, 80)}" cwd="${input.repoPath}" exitCode=${exitCode} stripped_env_keys=${JSON.stringify(strippedEnvKeys())}`
      );
      resolve({
        attempted: true,
        command: input.command!.command,
        status,
        ...(typeof code === "number" ? { exitCode: code } : {}),
        stdout: trimOutput(stdout),
        stderr: trimOutput(stderr),
        // IMPORTANT: for failures, keep raw-ish output so downstream parsers can extract
        // failing files/lines (e.g. Jest stack traces). For passes, keep it short.
        summary: status === "failed" ? buildFailureSummary(stdout, stderr) : summarizeOutput(stdout, stderr),
      });
    });
  });
}

export async function runRuntimeVerificationPlan(input: {
  repoPath: string;
  plan: SafeVerificationStep[];
  timeoutMsPerStep?: number;
}): Promise<RuntimeVerificationPlanResult> {
  if (input.plan.length === 0) {
    return {
      attempted: false,
      status: "skipped_no_command",
      steps: [],
      summary: "No safe verification command detected.",
    };
  }

  const steps: RuntimeVerificationPlanResult["steps"] = [];
  let attemptedAny = false;
  for (const step of input.plan) {
    const res = await runRuntimeVerification({
      repoPath: input.repoPath,
      command: step,
      timeoutMs: input.timeoutMsPerStep,
    });
    attemptedAny = attemptedAny || res.attempted;
    const combined = `${res.summary}`;
    const classifiedFailure =
      res.status === "failed" || (res.status === "skipped" && res.attempted === false)
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
