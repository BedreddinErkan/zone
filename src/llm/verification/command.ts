import { exec } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeVerificationEnv, strippedEnvKeys } from "../../core/buildEnv.js";

// Phase Q.4 invariant: runStagingVerification uses its own exec instance and
// reads err.stdout/err.stderr directly — it never goes through executeTool's
// run_command handler. truncateCommandOutput therefore does NOT affect
// pass/fail determination here.
export const execAsync_verify = promisify(exec);

export function selectVerificationCommand(
  framework: { language?: string; testCommand?: string } | undefined
): { command: string; timeoutMs: number; label: string } | null {
  if (!framework) return null;
  if (framework.language === "typescript") {
    return { command: "npx tsc --noEmit", timeoutMs: 60000, label: "tsc" };
  }
  if (framework.testCommand && (framework.language === "javascript" || framework.language === "python")) {
    return { command: framework.testCommand, timeoutMs: 90000, label: "test" };
  }
  return null;
}

// Phase J.3: count diagnostic errors in verification output. Used to compare
// pre-staging baseline vs post-staging output so projects with pre-existing
// errors don't have every patch blocked.
export function countVerificationErrors(label: string, output: string): number {
  const text = String(output || "");
  if (!text) return 0;
  if (label === "tsc") {
    // TypeScript: lines like `src/foo.ts(1,5): error TS2304: Cannot find name 'bar'.`
    const matches = text.match(/error TS\d+:/g);
    return matches ? matches.length : 0;
  }
  if (label === "test") {
    // Test runner output is heterogeneous; count common failure markers.
    // Covers vitest/jest (FAIL, ✗), pytest (FAILED, \d+ failed), and similar.
    let count = 0;
    count += (text.match(/\bFAIL(ED)?\b/g) || []).length;
    count += (text.match(/✗/g) || []).length;
    count += (text.match(/\d+ failed/i) ? 1 : 0);
    return Math.max(count, text ? 1 : 0);
  }
  return text ? 1 : 0;
}

export async function runVerificationCommand(
  choice: { command: string; timeoutMs: number; label: string },
  repoPath: string
): Promise<
  | { status: "pass"; durationMs: number }
  | { status: "fail"; durationMs: number; errorPreview: string }
> {
  const start = Date.now();
  try {
    await execAsync_verify(choice.command, {
      cwd: repoPath,
      timeout: choice.timeoutMs,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: sanitizeVerificationEnv(),
    });
    return { status: "pass", durationMs: Date.now() - start };
  } catch (err) {
    const stdout = String((err as { stdout?: unknown }).stdout ?? "");
    const stderr = String((err as { stderr?: unknown }).stderr ?? "");
    const combined = (stdout + "\n" + stderr).trim();
    const preview = combined.split("\n").slice(0, 30).join("\n").slice(0, 2000);
    return {
      status: "fail",
      durationMs: Date.now() - start,
      errorPreview: preview || String((err as Error).message ?? err),
    };
  }
}

export { strippedEnvKeys };
