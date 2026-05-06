import fs from "node:fs";
import path from "node:path";
import type { AuditSnapshot } from "./auditSnapshot.js";
import { errorLog } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// writeAuditSnapshot
// ---------------------------------------------------------------------------

/**
 * Writes a serialized AuditSnapshot to disk as pretty-printed JSON.
 *
 * Side-effect only: no return value, no mutation of the snapshot.
 * Parent directories are created automatically when missing.
 *
 * On failure the error is logged to stderr and the function returns normally —
 * it never throws and never affects stdout.
 *
 * @param snapshot - The AuditSnapshot to serialize.
 * @param filePath - Absolute or relative path for the output file.
 */
export function writeAuditSnapshot(
  snapshot: AuditSnapshot,
  filePath: string
): void {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorLog(`[audit] Failed to write snapshot: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// resolveAuditOutFlag
// ---------------------------------------------------------------------------

/**
 * Parses the `--audit-out=<path>` flag from a raw argv array.
 *
 * Accepts only the `--audit-out=value` form (equals-delimited). A flag with
 * an empty value (`--audit-out=`) is treated as absent and returns null.
 *
 * @param argv - The raw argument vector to inspect (e.g. process.argv).
 * @returns The path string when the flag is present with a non-empty value,
 *          or null when absent / empty.
 */
export function resolveAuditOutFlag(argv: string[]): string | null {
  const prefix = "--audit-out=";
  for (const arg of argv) {
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
