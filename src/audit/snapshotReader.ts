import fs from "node:fs";
import path from "node:path";
import type { AuditSnapshot } from "./auditSnapshot.js";

/**
 * Reads an audit snapshot JSON file from disk and parses it.
 *
 * Behavior:
 * - Returns parsed AuditSnapshot on success
 * - Returns null on any failure (file not found, invalid JSON, etc.)
 * - Logs error to stderr
 * - NEVER throws
 */
export function readAuditSnapshot(filePath: string): AuditSnapshot | null {
  try {
    const absolutePath = path.resolve(filePath);

    const raw = fs.readFileSync(absolutePath, "utf8");

    const parsed = JSON.parse(raw) as AuditSnapshot;

    return parsed;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    console.error(`[audit] Failed to read snapshot: ${message}`);

    return null;
  }
}