import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
}): SafeVerificationStep[] {
  const steps: SafeVerificationStep[] = [];
  const npm = getNpmExecutable();
  const scripts = parsePackageScripts(input.repoPath, input.repoFiles);
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

  if (hasPytestSignals(input.repoPath, input.repoFiles)) {
    steps.push({
      kind: "test",
      command: "pytest -q",
      executable: getPytestExecutable(),
      args: ["-q"],
    });
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
