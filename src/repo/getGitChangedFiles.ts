import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function normalizeGitPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").trim();
}

async function runGit(
  cwd: string,
  args: string[]
): Promise<string[]> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true
  });

  return stdout
    .split("\n")
    .map((line) => normalizeGitPath(line))
    .filter(Boolean);
}

async function getMergeBaseBranch(targetPath: string): Promise<string | null> {
  const candidates = ["origin/main", "origin/master", "main", "master"];

  for (const candidate of candidates) {
    try {
      await execFileAsync("git", ["rev-parse", "--verify", candidate], {
        cwd: targetPath,
        windowsHide: true
      });
      return candidate;
    } catch {
      // try next
    }
  }

  return null;
}

export async function getGitChangedFiles(targetPath: string): Promise<string[]> {
  try {
    const repoRootResult = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: targetPath,
        windowsHide: true
      }
    );

    const repoRoot = repoRootResult.stdout.trim();
    if (!repoRoot) {
      return [];
    }

    const relativeBase = path.relative(repoRoot, targetPath).replace(/\\/g, "/");
    const baseBranch = await getMergeBaseBranch(repoRoot);

    let changedFiles: string[] = [];

    if (baseBranch) {
      try {
        changedFiles = await runGit(repoRoot, [
          "diff",
          "--name-only",
          `${baseBranch}...HEAD`
        ]);
      } catch {
        changedFiles = [];
      }
    }

if (changedFiles.length === 0) {
  try {
    const statusResult = await execFileAsync("git", ["status", "--short"], {
      cwd: repoRoot,
      windowsHide: true
    });

    changedFiles = statusResult.stdout
      .split("\n")
      .map((line) => line.replace(/\\/g, "/"))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    changedFiles = [];
  }
}
    if (!relativeBase || relativeBase === "") {
      return [...new Set(changedFiles)];
    }

    return [
      ...new Set(
        changedFiles
          .filter((filePath) => filePath === relativeBase || filePath.startsWith(`${relativeBase}/`))
          .map((filePath) =>
            filePath.startsWith(`${relativeBase}/`)
              ? filePath.slice(relativeBase.length + 1)
              : path.basename(filePath)
          )
      )
    ];
  } catch {
    return [];
  }
}