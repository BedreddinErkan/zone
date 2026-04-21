import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type SafeVerificationCommand = {
  command: "npm test" | "npm run build" | "pytest -q";
  executable: string;
  args: string[];
};

function hasRepoFile(repoFiles: string[], fileName: string): boolean {
  return repoFiles.some((filePath) => filePath.replace(/\\/g, "/") === fileName);
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

export function detectVerificationCommand(input: {
  repoPath: string;
  repoFiles: string[];
}): SafeVerificationCommand | null {
  if (hasRepoFile(input.repoFiles, "package.json")) {
    const packageJson = readRepoText(input.repoPath, "package.json");
    try {
      const parsed = JSON.parse(packageJson) as {
        scripts?: Record<string, string>;
      };
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
    } catch {
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
