import type { ContradictionFlag } from "../engine/contradictionDetector.js";
import type { AuditSnapshot } from "../audit/auditSnapshot.js";

/**
 * Prints contradiction flags to stdout.
 * Each flag is prefixed with a warning emoji and shows its type and message.
 * No-ops when the flags array is empty.
 */
export function printContradictionFlags(flags: ContradictionFlag[]): void {
  if (flags.length === 0) {
    return;
  }

  for (const flag of flags) {
    console.log(`\u26a0\ufe0f [${flag.type}] ${flag.message}`);
  }
}

/**
 * Serializes a full AuditSnapshot to stdout as pretty-printed JSON.
 * No-ops silently when snapshot is null or undefined.
 * Never throws — any serialization errors are swallowed.
 */
export function printAuditSnapshot(
  snapshot: AuditSnapshot | null | undefined
): void {
  if (snapshot == null) {
    return;
  }
  try {
    console.log(JSON.stringify(snapshot, null, 2));
  } catch {
    // serialization errors must never propagate from a print helper
  }
}
