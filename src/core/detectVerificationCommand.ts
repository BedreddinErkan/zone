import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execPath } from "node:process";

export type SafeVerificationCommand = {
  command: string;
  executable: string;
  args: string[];
};

export type VerificationStepKind = "typecheck" | "lint" | "test";

export type SafeVerificationStep = SafeVerificationCommand & {
  kind: VerificationStepKind;
};

function hasRepoFile(repoFiles: string[], fileName: string): boolean {
  const normalizedFileName = fileName.replace(/\\/g, "/").toLowerCase();
  return repoFiles.some(
    (filePath) => filePath.replace(/\\/g, "/").toLowerCase() === normalizedFileName
  );
}

function readRepoText(repoPath: string, fileName: string): string {
  const path = join(repoPath, fileName);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function getNpmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function getPytestExecutable(): string {
  return process.platform === "win32" ? "pytest.exe" : "pytest";
}

function parsePackageScripts(repoPath: string, repoFiles: string[]): Record<string, string> {
  if (!hasRepoFile(repoFiles, "package.json")) return {};
  const packageJson = readRepoText(repoPath, "package.json");
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function parseSubPackageScripts(
  repoPath: string,
  repoFiles: string[],
  relPackageJsonPath: string
): Record<string, string> {
  if (!hasRepoFile(repoFiles, relPackageJsonPath)) return {};
  const packageJson = readRepoText(repoPath, relPackageJsonPath);
  try {
    const parsed = JSON.parse(packageJson) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function hasScript(scripts: Record<string, string>, name: string): boolean {
  const value = scripts[name];
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeTaskHints(task: string): { wantsE2E: boolean; wantsUnit: boolean } {
  const t = task.toLowerCase();
  return {
    wantsE2E: /e2e|playwright|cypress/.test(t),
    wantsUnit: /\bunit\b|\bunit[-_\s]?test\b/.test(t),
  };
}

function isPatchedTypeScriptSourceFile(filePath: string): boolean {
  const n = filePath.replace(/\\/g, "/");
  if (/\.tsx$/i.test(n)) return true;
  if (/\.ts$/i.test(n) && !/\.d\.ts$/i.test(n)) return true;
  return false;
}

function planAlreadyRunsTscNoEmit(steps: SafeVerificationStep[]): boolean {
  return steps.some((s) => /\btsc\b/.test(s.command) && /--noEmit\b/.test(s.command));
}

function buildTscNoEmitStep(repoPath: string): SafeVerificationStep | null {
  const tscJs = join(repoPath, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(tscJs)) {
    return {
      kind: "typecheck",
      command: "tsc --noEmit",
      executable: execPath,
      args: [tscJs, "--noEmit"],
    };
  }
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return {
    kind: "typecheck",
    command: "npx tsc --noEmit",
    executable: npx,
    args: ["tsc", "--noEmit"],
  };
}

function hasPytestSignals(repoPath: string, repoFiles: string[]): boolean {
  if (
    hasRepoFile(repoFiles, "pytest.ini") ||
    repoFiles.some((filePath) => /(^|\/)(test|tests|__tests__)\//i.test(filePath)) ||
    repoFiles.some((filePath) => /\.(test|spec)\.py$/i.test(filePath))
  ) {
    return true;
  }

  const requirements = readRepoText(repoPath, "requirements.txt");
  if (/\bpytest\b/i.test(requirements)) return true;

  const pyproject = readRepoText(repoPath, "pyproject.toml");
  return /\bpytest\b/i.test(pyproject);
}

export function detectVerificationPlan(input: {
  repoPath: string;
  repoFiles: string[];
  task?: string;
  /** After a patch: if any changed file is .ts/.tsx, queue `tsc --noEmit` before tests. */
  patchedFilePaths?: string[];
}): SafeVerificationStep[] {
  const steps: SafeVerificationStep[] = [];
  const npm = getNpmExecutable();
  const scripts = parsePackageScripts(input.repoPath, input.repoFiles);
  const serverScripts = parseSubPackageScripts(input.repoPath, input.repoFiles, "server/package.json");
  const hints = normalizeTaskHints(input.task ?? "");

  if (Object.keys(scripts).length > 0) {
    // Typecheck first.
    if (hasScript(scripts, "typecheck")) {
      steps.push({ kind: "typecheck", command: "npm run typecheck", executable: npm, args: ["run", "typecheck"] });
    } else if (hasScript(scripts, "tsc")) {
      steps.push({ kind: "typecheck", command: "npm run tsc", executable: npm, args: ["run", "tsc"] });
    }

    // Lint next.
    if (hasScript(scripts, "lint")) {
      steps.push({ kind: "lint", command: "npm run lint", executable: npm, args: ["run", "lint"] });
    }

    // Then tests (task-aware).
    if (hints.wantsE2E) {
      if (hasScript(scripts, "test:e2e")) {
        steps.push({ kind: "test", command: "npm run test:e2e", executable: npm, args: ["run", "test:e2e"] });
      } else if (hasScript(scripts, "playwright")) {
        steps.push({ kind: "test", command: "npm run playwright", executable: npm, args: ["run", "playwright"] });
      } else if (hasScript(scripts, "test")) {
        steps.push({ kind: "test", command: "npm test", executable: npm, args: ["test"] });
      }
    } else if (hints.wantsUnit) {
      if (hasScript(scripts, "test:unit")) {
        steps.push({ kind: "test", command: "npm run test:unit", executable: npm, args: ["run", "test:unit"] });
      } else if (hasScript(scripts, "test")) {
        steps.push({ kind: "test", command: "npm test", executable: npm, args: ["test"] });
      }
    } else {
      if (hasScript(scripts, "test")) {
        steps.push({ kind: "test", command: "npm test", executable: npm, args: ["test"] });
      } else if (hasScript(scripts, "test:unit")) {
        steps.push({ kind: "test", command: "npm run test:unit", executable: npm, args: ["run", "test:unit"] });
      } else if (hasScript(scripts, "test:e2e")) {
        steps.push({ kind: "test", command: "npm run test:e2e", executable: npm, args: ["run", "test:e2e"] });
      }
    }

    // If repo is JS but has no tests, fall back to build.
    if (!steps.some((s) => s.kind === "test") && hasScript(scripts, "build")) {
      steps.push({ kind: "test", command: "npm run build", executable: npm, args: ["run", "build"] });
    }
  }

  // Monorepo secondary step: if server has unit tests, run them too.
  // Use `npm --prefix server test` so we don't rely on shell `cd`.
  if (Object.keys(serverScripts).length > 0 && hasScript(serverScripts, "test")) {
    steps.push({
      kind: "test",
      command: "cd server && npm test",
      executable: npm,
      args: ["--prefix", "server", "test"],
    });
  }

  // If we patched a server/ file, prefer server unit tests BEFORE e2e.
  // This avoids "no tests found" from e2e blocking targeted backend fixes.
  const patched = input.patchedFilePaths ?? [];
  const patchedTouchesServer = patched.some((p) => p.replace(/\\/g, "/").startsWith("server/"));
  if (patchedTouchesServer) {
    const serverIdx = steps.findIndex((s) => s.command === "cd server && npm test");
    if (serverIdx > 0) {
      const [serverStep] = steps.splice(serverIdx, 1);
      const firstTestIdx = steps.findIndex((s) => s.kind === "test");
      if (firstTestIdx === -1) {
        steps.unshift(serverStep);
      } else {
        steps.splice(firstTestIdx, 0, serverStep);
      }
    }
    // For backend-only patches, keep verification focused on server unit tests
    // to avoid unrelated e2e/playwright noise.
    const serverTestStep = steps.find((s) => s.command === "cd server && npm test");
    const nonTestSteps = steps.filter((s) => s.kind !== "test");
    if (serverTestStep) {
      steps.length = 0;
      steps.push(...nonTestSteps, serverTestStep);
    }
  }

  if (!patchedTouchesServer && hasPytestSignals(input.repoPath, input.repoFiles)) {
    steps.push({
      kind: "test",
      command: "pytest -q",
      executable: getPytestExecutable(),
      args: ["-q"],
    });
  }

  if (
    patched.some(isPatchedTypeScriptSourceFile) &&
    !planAlreadyRunsTscNoEmit(steps)
  ) {
    const tscStep = buildTscNoEmitStep(input.repoPath);
    if (tscStep) {
      const firstTestIdx = steps.findIndex((s) => s.kind === "test");
      if (firstTestIdx === -1) {
        steps.push(tscStep);
      } else {
        steps.splice(firstTestIdx, 0, tscStep);
      }
    }
  }

  return steps;
}

export function detectVerificationCommand(input: {
  repoPath: string;
  repoFiles: string[];
}): SafeVerificationCommand | null {
  const plan = detectVerificationPlan({ ...input });
  return plan.length > 0 ? { command: plan[0].command, executable: plan[0].executable, args: plan[0].args } : null;
}
