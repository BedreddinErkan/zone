import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { log } from "../utils/logger.js";
import picomatch from "picomatch";

export interface UserHookEntry {
  matchTools?: string[];
  matchPaths?: string[];
  command: string;
  description?: string;
  timeoutMs?: number;
  feedOutputToModel?: boolean;
}

export interface UserHooksConfig {
  version: 1;
  hooks: {
    PreToolUse?: UserHookEntry[];
    PostToolUse?: UserHookEntry[];
  };
  /** Raw file bytes for hash re-verification. NOT written to disk. */
  _rawBytes?: Buffer;
}

const HOOKS_MIN_TIMEOUT_MS = 1_000;
const HOOKS_MAX_TIMEOUT_MS = 120_000;

function clampTimeout(ms: unknown): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return 30_000;
  return Math.min(Math.max(Math.round(ms), HOOKS_MIN_TIMEOUT_MS), HOOKS_MAX_TIMEOUT_MS);
}

function validateEntry(raw: unknown): UserHookEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.command !== "string" || !obj.command.trim()) return null;

  const entry: UserHookEntry = { command: obj.command };
  if (Array.isArray(obj.matchTools) && obj.matchTools.every((t) => typeof t === "string")) {
    entry.matchTools = obj.matchTools as string[];
  }
  if (Array.isArray(obj.matchPaths) && obj.matchPaths.every((p) => typeof p === "string")) {
    entry.matchPaths = obj.matchPaths as string[];
  }
  if (typeof obj.description === "string") entry.description = obj.description;
  if (obj.timeoutMs !== undefined) entry.timeoutMs = clampTimeout(obj.timeoutMs);
  if (typeof obj.feedOutputToModel === "boolean") entry.feedOutputToModel = obj.feedOutputToModel;
  return entry;
}

export async function loadDiskHooks(repoPath: string): Promise<UserHooksConfig | null> {
  const hooksPath = join(repoPath, ".zone", "hooks.json");
  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(hooksPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes.toString("utf-8"));
  } catch {
    log("[zone-hooks-load-error]", "hooks.json is not valid JSON — skipping");
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    log("[zone-hooks-load-error]", "hooks.json must be an object — skipping");
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    log("[zone-hooks-load-error]", `hooks.json version must be 1, got ${String(obj.version)} — skipping`);
    return null;
  }
  if (!obj.hooks || typeof obj.hooks !== "object" || Array.isArray(obj.hooks)) {
    log("[zone-hooks-load-error]", "hooks.json missing 'hooks' object — skipping");
    return null;
  }

  const hooks = obj.hooks as Record<string, unknown>;
  const parseSection = (key: string): UserHookEntry[] | undefined => {
    if (!Array.isArray(hooks[key])) return undefined;
    const valid = (hooks[key] as unknown[]).map(validateEntry).filter((e): e is UserHookEntry => e !== null);
    return valid.length > 0 ? valid : undefined;
  };

  const config: UserHooksConfig = {
    version: 1,
    hooks: {
      PreToolUse: parseSection("PreToolUse"),
      PostToolUse: parseSection("PostToolUse"),
    },
    _rawBytes: rawBytes,
  };
  return config;
}

export function hooksConfigHash(rawBytes: Buffer): string {
  return createHash("sha256").update(rawBytes).digest("hex");
}

// Shell metacharacters that could cause injection if interpolated unquoted
const UNSAFE_PATH_CHARS = /[;|&`$><!\{\}\(\)\*\?~\n\r"'\\]/;

export function isSafeFilePath(filePath: string): boolean {
  return !UNSAFE_PATH_CHARS.test(filePath);
}

export function matchesHook(
  entry: UserHookEntry,
  toolName: string,
  filePath: string | null,
): boolean {
  if (entry.matchTools && entry.matchTools.length > 0) {
    if (!entry.matchTools.includes(toolName)) return false;
  }
  if (entry.matchPaths && entry.matchPaths.length > 0) {
    if (!filePath) return false;
    const isMatch = picomatch(entry.matchPaths);
    if (!isMatch(filePath)) return false;
  }
  return true;
}

export function extractFileArg(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  // Same fields the scope guard checks
  const val = args.file_path ?? args.path ?? args.file;
  if (typeof val === "string" && val.length > 0) return val;
  // For apply_patch, the path is inside the patch text — not extractable easily;
  // return null so path-matchers won't fire, but tool-matchers still work.
  if (toolName === "apply_patch") return null;
  return null;
}
