import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface BranchInfo {
  name: string;
  current: boolean;
  /** Absolute path of the worktree that has this branch checked out, or null. */
  checkedOutAt: string | null;
}

export interface BranchListResult {
  current: string | null;
  detached: boolean;
  branches: BranchInfo[];
}

export interface BranchSwitchResult {
  ok: boolean;
  error?: "uncommitted_changes" | "not_found" | "not_a_repo" | "git_failure" | "in_use_by_worktree";
  message?: string;
  dirtyFiles?: string[];
  worktreePath?: string;
}

export interface BranchCreateResult {
  ok: boolean;
  error?: "exists" | "invalid_name" | "not_a_repo" | "git_failure";
  message?: string;
  branch?: string;
}

const INVALID_BRANCH_RE = /[\s~^:?*\[\\]/;

function isValidBranchName(name: string): boolean {
  if (!name || name.length === 0) return false;
  if (name.startsWith("-")) return false;
  if (name.includes("..")) return false;
  if (INVALID_BRANCH_RE.test(name)) return false;
  return true;
}

async function gitOk(
  cwd: string,
  args: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function isInsideWorkTree(repoPath: string): Promise<boolean> {
  const result = await gitOk(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

/**
 * Parse `git worktree list --porcelain` output into a map of
 * branch name → worktree absolute path. Only entries with a branch
 * (not bare, not detached) are included.
 */
function parseWorktreePorcelain(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  const blocks = stdout.trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    let worktreePath = "";
    let branch = "";
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length).trim();
      } else if (line.startsWith("branch ")) {
        // refs/heads/feature/foo → feature/foo
        branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      }
    }
    if (worktreePath && branch) {
      map.set(branch, worktreePath);
    }
  }
  return map;
}

export async function listBranches(repoPath: string): Promise<BranchListResult> {
  const inside = await isInsideWorkTree(repoPath);
  if (!inside) {
    return { current: null, detached: false, branches: [] };
  }

  const headRef = await gitOk(repoPath, ["symbolic-ref", "--short", "HEAD"]);
  let current: string | null = null;
  let detached = false;
  if (headRef.ok) {
    current = headRef.stdout.trim() || null;
  } else {
    detached = true;
  }

  const refs = await gitOk(repoPath, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);

  const names: string[] = refs.ok
    ? refs.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
    : [];

  // Worktree map: branch → absolute worktree path
  const wtResult = await gitOk(repoPath, ["worktree", "list", "--porcelain"]);
  const worktreeMap = wtResult.ok ? parseWorktreePorcelain(wtResult.stdout) : new Map<string, string>();

  // Normalise repoPath for comparison (resolve symlinks would be ideal but
  // path.resolve is a good-enough heuristic for the common case).
  const normRepo = path.resolve(repoPath);

  const toBranchInfo = (name: string): BranchInfo => {
    const wtPath = worktreeMap.get(name) ?? null;
    // checkedOutAt is non-null only when a *different* worktree holds this branch
    const checkedOutAt = wtPath && path.resolve(wtPath) !== normRepo ? wtPath : null;
    return { name, current: name === current, checkedOutAt };
  };

  // Current branch first, rest sorted
  if (current && names.includes(current)) {
    const ordered = [current, ...names.filter((b) => b !== current)];
    return { current, detached, branches: ordered.map(toBranchInfo) };
  }

  return { current, detached, branches: names.map(toBranchInfo) };
}

export async function switchBranch(
  repoPath: string,
  branchName: string
): Promise<BranchSwitchResult> {
  if (!isValidBranchName(branchName)) {
    return { ok: false, error: "git_failure", message: "Invalid branch name" };
  }

  const inside = await isInsideWorkTree(repoPath);
  if (!inside) {
    return { ok: false, error: "not_a_repo" };
  }

  const verify = await gitOk(repoPath, ["rev-parse", "--verify", branchName]);
  if (!verify.ok) {
    return { ok: false, error: "not_found" };
  }

  // Reject if the branch is checked out in a different worktree.
  const wtResult = await gitOk(repoPath, ["worktree", "list", "--porcelain"]);
  if (wtResult.ok) {
    const worktreeMap = parseWorktreePorcelain(wtResult.stdout);
    const wtPath = worktreeMap.get(branchName);
    if (wtPath && path.resolve(wtPath) !== path.resolve(repoPath)) {
      return {
        ok: false,
        error: "in_use_by_worktree",
        worktreePath: wtPath,
        message: `Branch is checked out at: ${wtPath}`,
      };
    }
  }

  const status = await gitOk(repoPath, ["status", "--porcelain"]);
  if (status.ok && status.stdout.length > 0) {
    const dirtyFiles = status.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (dirtyFiles.length > 0) {
      return { ok: false, error: "uncommitted_changes", dirtyFiles };
    }
  }

  const checkout = await gitOk(repoPath, ["checkout", branchName]);
  if (!checkout.ok) {
    return {
      ok: false,
      error: "git_failure",
      message: checkout.stderr.trim() || "git checkout failed",
    };
  }

  return { ok: true };
}

export async function createBranch(
  repoPath: string,
  branchName: string,
  baseBranch?: string
): Promise<BranchCreateResult> {
  if (!isValidBranchName(branchName)) {
    return { ok: false, error: "invalid_name" };
  }

  const inside = await isInsideWorkTree(repoPath);
  if (!inside) {
    return { ok: false, error: "not_a_repo" };
  }

  const verifyExisting = await gitOk(repoPath, [
    "rev-parse",
    "--verify",
    branchName,
  ]);
  if (verifyExisting.ok) {
    return { ok: false, error: "exists" };
  }

  if (baseBranch) {
    const verifyBase = await gitOk(repoPath, [
      "rev-parse",
      "--verify",
      baseBranch,
    ]);
    if (!verifyBase.ok) {
      return {
        ok: false,
        error: "git_failure",
        message: "Base branch not found",
      };
    }
  }

  const args = baseBranch
    ? ["checkout", "-b", branchName, baseBranch]
    : ["checkout", "-b", branchName];
  const checkout = await gitOk(repoPath, args);
  if (!checkout.ok) {
    return {
      ok: false,
      error: "git_failure",
      message: checkout.stderr.trim() || "git checkout -b failed",
    };
  }

  return { ok: true, branch: branchName };
}
