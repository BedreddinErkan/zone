import fs from "node:fs";
import path from "node:path";

export interface RunEnvironmentResult {
  valid: boolean;
  issue?: string;
  hint?: string;
}

// Commands that require node_modules to be present in the working directory.
const NODE_COMMAND_RE = /\b(npm|npx|yarn|pnpm|vitest|jest|tsc)\b/;

function detectInstallCommand(dir: string): string {
  if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm install";
  if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn install";
  return "npm install";
}

/**
 * D7: Validate environment preconditions before a shell command runs.
 *
 * Returns valid:false with an actionable message when the working directory
 * is missing dependencies that the command requires, so the agent gets a
 * clear diagnosis instead of a confusing "module not found" failure after
 * consuming an iteration.
 *
 * Returns valid:true with issue+hint for warnings (stale lockfile) that do
 * not block execution but are worth surfacing to the agent.
 */
export function validateRunEnvironment(
  dir: string,
  command: string,
): RunEnvironmentResult {
  if (!NODE_COMMAND_RE.test(command)) {
    return { valid: true };
  }

  const nmPath = path.join(dir, "node_modules");
  if (!fs.existsSync(nmPath)) {
    const installCmd = detectInstallCommand(dir);
    return {
      valid: false,
      issue: `node_modules/ not found in ${dir}`,
      hint: `Run \`${installCmd}\` to install dependencies before running build/test commands.`,
    };
  }

  // Stale lockfile warning (valid:true — does not block execution).
  // Uses npm's internal .package-lock.json which is updated on every install.
  const lockfileName = fs.existsSync(path.join(dir, "pnpm-lock.yaml"))
    ? "pnpm-lock.yaml"
    : fs.existsSync(path.join(dir, "yarn.lock"))
      ? "yarn.lock"
      : fs.existsSync(path.join(dir, "package-lock.json"))
        ? "package-lock.json"
        : null;

  if (lockfileName) {
    const installedLockPath = path.join(nmPath, ".package-lock.json");
    if (fs.existsSync(installedLockPath)) {
      try {
        const lockMtime = fs.statSync(path.join(dir, lockfileName)).mtimeMs;
        const installedMtime = fs.statSync(installedLockPath).mtimeMs;
        if (lockMtime > installedMtime) {
          return {
            valid: true,
            issue: `${lockfileName} is newer than installed node_modules — dependencies may be out of sync`,
            hint: `Run \`${detectInstallCommand(dir)}\` to sync.`,
          };
        }
      } catch {
        // stat failures are not worth blocking on
      }
    }
  }

  return { valid: true };
}
