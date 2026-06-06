import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeVerificationEnv, strippedEnvKeys } from "../../core/buildEnv.js";

// Phase Q.4 invariant: runStagingVerification uses its own exec instance and
// reads err.stdout/err.stderr directly — it never goes through executeTool's
// run_command handler. truncateCommandOutput therefore does NOT affect
// pass/fail determination here.
export const execAsync_verify = promisify(exec);

/**
 * Locate the tsconfig.json that should drive an inline type-check.
 *
 * A bare `tsc --noEmit` run at a monorepo root resolves no inputs and prints
 * its usage banner instead of type-checking — and path aliases (`@/...`) never
 * resolve. We walk up from each staged file's directory (bounded by repoPath)
 * to find the nearest tsconfig.json so `-p <tsconfig>` makes aliases resolve.
 *
 * Returns the absolute tsconfig path, or null when none is found (caller falls
 * back to the bare command). Never throws.
 */
function buildFoundTsconfigSet(repoPath: string, stagingFiles?: Map<string, string>): Set<string> {
  const repoAbs = path.resolve(repoPath);
  const startDirs = new Set<string>();
  if (stagingFiles) {
    for (const abs of stagingFiles.keys()) startDirs.add(path.dirname(path.resolve(abs)));
  }
  if (startDirs.size === 0) startDirs.add(repoAbs);

  const found = new Set<string>();
  for (const start of startDirs) {
    let dir = start;
    // Walk up to (and including) repoPath, never escaping it.
    while (true) {
      const candidate = path.join(dir, "tsconfig.json");
      try {
        if (fs.existsSync(candidate)) {
          found.add(candidate);
          break;
        }
      } catch {
        /* ignore unreadable dir */
      }
      if (dir === repoAbs) break;
      const parent = path.dirname(dir);
      if (parent === dir) break; // filesystem root
      if (!parent.startsWith(repoAbs)) break; // don't walk above repoPath
      dir = parent;
    }
  }
  return found;
}

export function resolveTsconfigProject(
  repoPath: string,
  stagingFiles?: Map<string, string>
): string | null {
  const repoAbs = path.resolve(repoPath);
  const found = buildFoundTsconfigSet(repoPath, stagingFiles);
  if (found.size === 1) return [...found][0]!;
  // Cross-package change (multiple configs) or none found near the files:
  // prefer the repo-root tsconfig, else a deterministic pick, else null.
  const rootTsconfig = path.join(repoAbs, "tsconfig.json");
  if (fs.existsSync(rootTsconfig)) return rootTsconfig;
  if (found.size > 0) return [...found].sort()[0]!;
  return null;
}

/**
 * Returns every distinct tsconfig.json found nearest to the staged files,
 * one per package. When staged files span multiple packages, the returned
 * array has one entry per package (sorted for determinism). Empty array means
 * no tsconfig was found anywhere up to repoPath — caller should fall back to
 * the bare `tsc --noEmit` command.
 */
export function resolveAllTsconfigProjects(
  repoPath: string,
  stagingFiles?: Map<string, string>
): string[] {
  const found = buildFoundTsconfigSet(repoPath, stagingFiles);
  if (found.size === 0) return [];
  return [...found].sort();
}

export function selectVerificationCommand(
  framework: { language?: string; testCommand?: string } | undefined,
  ctx?: { repoPath?: string; stagingFiles?: Map<string, string> }
): { command: string; timeoutMs: number; label: string } | null {
  if (!framework) return null;
  if (framework.language === "typescript") {
    let command = "npx tsc --noEmit";
    if (ctx?.repoPath) {
      const project = resolveTsconfigProject(ctx.repoPath, ctx.stagingFiles);
      if (project) {
        const rel = (path.relative(ctx.repoPath, project) || "tsconfig.json").replace(/\\/g, "/");
        const projectArg = /[\s'"]/.test(rel) ? `"${rel}"` : rel;
        command = `npx tsc --noEmit -p ${projectArg}`;
      }
    }
    return { command, timeoutMs: 60000, label: "tsc" };
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
