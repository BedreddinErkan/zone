/**
 * Phase J.5.1 — filesystem-first cross-run conversation store.
 *
 * J.5 shipped with Supabase as the only persistence layer for the
 * `agent_summary` event used to thread APPLY_ROLLED_BACK markers
 * between runs. Memory #24 / dogfood revealed that the typical Zone
 * deployment is self-host, where SUPABASE_URL is unset — so the
 * persist + load path were no-ops in production despite the J.4/J.5
 * code being structurally correct.
 *
 * This module adds a project-local JSONL store at
 *   <repoPath>/.zone/conversations/<threadId>.jsonl
 * that ALWAYS fires (no env dependency). Supabase remains an optional
 * accelerator layer — both layers run in parallel on write, and the
 * read side falls back to filesystem when Supabase is empty / errors.
 *
 * Path-traversal: threadId is untrusted client input, so it must match
 * a strict allowlist before becoming part of a filesystem path.
 */

import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** Strict allowlist for threadId path components (uuid-ish + dashes only). */
const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Keep the most-recent N events per thread; older lines drop on write. */
export const FS_CONVERSATION_MAX_EVENTS = 50;

/** Subdir under <repoPath>/.zone/ that holds the per-thread JSONL files. */
export const FS_CONVERSATION_DIR = path.join(".zone", "conversations");

/** Single typed event (mirrors the Supabase row shape). */
export interface FsConversationEvent {
  type: "user" | "run" | "agent_summary" | string;
  ts: number | string;
  /** type === "agent_summary" — text body (capped + marker-preserved upstream). */
  text?: string;
  /** type === "agent_summary" — surfaces "rolled_back" so readers can filter. */
  decisionMode?: string;
  /** type === "turn" — head-keep snapshot of patchPreview for continuation context (≤16KB). Absent on aborted/no-preview turns. */
  fullAnswer?: string;
  /** Free-form extras. */
  [k: string]: unknown;
}

/** True iff `id` is shaped acceptably for use as a path component. */
export function isValidThreadId(id: unknown): id is string {
  return typeof id === "string" && THREAD_ID_PATTERN.test(id);
}

function conversationFilePath(repoPath: string, threadId: string): string {
  return path.join(repoPath, FS_CONVERSATION_DIR, `${threadId}.jsonl`);
}

/**
 * Append one event to <repoPath>/.zone/conversations/<threadId>.jsonl.
 *
 * Returns `true` on a successful write, `false` for any graceful skip
 * (missing/invalid inputs, FS error, path-traversal rejection). Never
 * throws — caller is the persistence orchestrator, which has its own
 * graceful-degrade contract.
 *
 * Rotation: if the file already has FS_CONVERSATION_MAX_EVENTS lines or
 * more, the oldest lines are dropped before the new line is appended,
 * so the file stays bounded.
 */
export async function appendFsConversationEvent(input: {
  repoPath: string;
  threadId: string;
  event: FsConversationEvent;
}): Promise<boolean> {
  const { repoPath, threadId, event } = input;
  if (!repoPath || typeof repoPath !== "string") return false;
  if (!isValidThreadId(threadId)) return false;
  if (!event || typeof event !== "object" || !event.type) return false;

  const filePath = conversationFilePath(repoPath, threadId);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  } catch {
    return false;
  }

  // Rotation: read existing (if any), trim to last N-1, write back + new line.
  // For small files (≤50 lines, each typically <2KB) this is cheap.
  let existing: string[] = [];
  try {
    const raw = await fs.readFile(filePath, "utf8");
    existing = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return false;
  }
  const keepCount = Math.max(0, FS_CONVERSATION_MAX_EVENTS - 1);
  const head = existing.length > keepCount ? existing.slice(existing.length - keepCount) : existing;

  let line: string;
  try {
    line = JSON.stringify(event);
  } catch {
    return false;
  }
  const out = head.length > 0 ? `${head.join("\n")}\n${line}\n` : `${line}\n`;
  try {
    await fs.writeFile(filePath, out, "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the persisted events for a thread, oldest-first.
 *
 * Returns `[]` on any of: missing file, invalid inputs, FS error,
 * path-traversal rejection. Malformed lines are skipped (best-effort
 * parse). Caller treats the empty result identically to "no thread".
 */
export function readFsConversationEvents(input: {
  repoPath: string;
  threadId: string;
}): FsConversationEvent[] {
  const { repoPath, threadId } = input;
  if (!repoPath || typeof repoPath !== "string") return [];
  if (!isValidThreadId(threadId)) return [];

  const filePath = conversationFilePath(repoPath, threadId);
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out: FsConversationEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object" && typeof parsed.type === "string") {
        out.push(parsed as FsConversationEvent);
      }
    } catch {
      // Malformed line — skip; don't fail the whole read.
    }
  }
  return out;
}
