import { spawn } from "node:child_process";
import { sanitizeVerificationEnv } from "../core/buildEnv.js";
import type { UserHookEntry, UserHooksConfig } from "../api/diskHooks.js";
import { matchesHook, extractFileArg, isSafeFilePath } from "../api/diskHooks.js";
import { debugLog } from "../utils/logger.js";

export { UserHooksConfig };

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
const MAX_STDERR_CHARS = 500;

export interface UserHookRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errored: boolean;
  error?: unknown;
}

async function runUserHookShell(
  hook: UserHookEntry,
  event: string,
  toolName: string,
  filePath: string | null,
  repoPath: string,
  meta: { runId?: string | null; iter: number },
): Promise<UserHookRunResult> {
  const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;

  const baseEnv = sanitizeVerificationEnv();
  const hookEnv: Record<string, string> = {
    ...baseEnv,
    ZONE_HOOK_EVENT: event,
    ZONE_TOOL_NAME: toolName,
    ZONE_RUN_ID: meta.runId ?? "",
    ZONE_ITER: String(meta.iter),
  };
  if (filePath !== null && isSafeFilePath(filePath)) {
    hookEnv.ZONE_TOOL_FILE = filePath;
  }

  const payload = JSON.stringify({
    event,
    toolName,
    filePath: filePath ?? null,
    repoPath,
    runId: meta.runId ?? null,
    iter: meta.iter,
  });

  return new Promise<UserHookRunResult>((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const MAX_BUF = 10 * 1024 * 1024;

    const child = spawn("/bin/sh", ["-c", hook.command], {
      cwd: repoPath,
      env: hookEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ exitCode: null, stdout: stdoutBuf, stderr: stderrBuf, timedOut: true, errored: true });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_BUF) stdoutBuf += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < MAX_BUF) stderrBuf += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: stdoutBuf, stderr: stderrBuf, timedOut: false, errored: true, error: err });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? null, stdout: stdoutBuf, stderr: stderrBuf, timedOut: false, errored: false });
    });

    // Write JSON payload to stdin then close it
    try {
      child.stdin?.write(payload);
      child.stdin?.end();
    } catch {
      // stdin may be closed if the process exits immediately
    }
  });
}

export interface PreToolUseVetoResult {
  vetoed: true;
  hookDesc: string;
  result: UserHookRunResult;
  filePath: string | null;
}

export type PreToolUseResult =
  | { vetoed: false }
  | PreToolUseVetoResult;

export async function runUserPreToolUseHooks(
  hooks: UserHookEntry[],
  toolName: string,
  args: Record<string, unknown>,
  repoPath: string,
  meta: { runId?: string | null; iter: number },
): Promise<PreToolUseResult> {
  const filePath = extractFileArg(toolName, args);

  for (const hook of hooks) {
    if (!matchesHook(hook, toolName, filePath)) continue;

    debugLog("[zone-user-hook-pre]", { toolName, filePath, desc: hook.description });
    const result = await runUserHookShell(hook, "PreToolUse", toolName, filePath, repoPath, meta);

    // Fail-closed: non-zero exit, timeout, or error → veto
    if (result.errored || result.timedOut || result.exitCode !== 0) {
      return {
        vetoed: true,
        hookDesc: hook.description ?? hook.command.slice(0, 60),
        result,
        filePath,
      };
    }
  }
  return { vetoed: false };
}

export async function runUserPostToolUseHooks(
  hooks: UserHookEntry[],
  toolName: string,
  args: Record<string, unknown>,
  repoPath: string,
  meta: { runId?: string | null; iter: number; callId: string },
  feedOutputCallback: (stdout: string) => void,
): Promise<void> {
  const filePath = extractFileArg(toolName, args);

  for (const hook of hooks) {
    if (!matchesHook(hook, toolName, filePath)) continue;

    debugLog("[zone-user-hook-post]", { toolName, filePath, desc: hook.description });
    const result = await runUserHookShell(hook, "PostToolUse", toolName, filePath, repoPath, meta);

    if (!result.errored && !result.timedOut && result.exitCode === 0) {
      if (hook.feedOutputToModel && result.stdout.trim()) {
        feedOutputCallback(result.stdout);
      }
    } else {
      // Non-fatal: log and continue
      debugLog("[zone-user-hook-post-warn]", {
        toolName, desc: hook.description,
        exitCode: result.exitCode, timedOut: result.timedOut,
      });
    }
  }
}

export function buildVetoContent(
  toolName: string,
  filePath: string | null,
  veto: PreToolUseVetoResult,
  isPermanent: boolean,
): string {
  const { hookDesc, result } = veto;
  const stderrSnippet = result.stderr.slice(0, MAX_STDERR_CHARS);
  const fileNote = filePath ? ` on ${filePath}` : "";
  const exitNote = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "error"}`;

  if (isPermanent) {
    return [
      `[hook_blocked] PERMANENTLY BLOCKED — hook '${hookDesc}' vetoed ${toolName}${fileNote}.`,
      `This hook will reject every attempt. Do NOT retry ${toolName}${filePath ? ` on ${filePath}` : ""}.`,
      stderrSnippet ? `\nstderr: ${stderrSnippet}` : "",
    ].filter(Boolean).join("\n");
  }

  return [
    `[hook_blocked] PreToolUse hook '${hookDesc}' vetoed ${toolName}${fileNote} (${exitNote}).`,
    stderrSnippet ? `stderr: ${stderrSnippet}` : "",
    `Do not retry on the same path — the hook will reject every attempt.`,
  ].filter(Boolean).join("\n");
}
