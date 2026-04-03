import type {
  DecisionEngineInput,
  DecisionEngineResult,
} from "../engine/decisionEngine.js";
import type {
  ContradictionFlag,
  ExecutionMode,
} from "../engine/contradictionDetector.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TraceReasonEntry = {
  code: string;
  severity: string;
  category: string;
  message: string;
};

export type AuditSnapshot = Readonly<{
  /** Deterministic content-addressed ID: base64 of (JSON.stringify(input) + timestamp). */
  snapshotId: string;
  /** ISO 8601 timestamp of the moment the snapshot was created. */
  timestamp: string;
  /** The DecisionEngineInput that produced this decision. */
  input: DecisionEngineInput;
  /** The full DecisionEngineResult, including contradictionFlags. */
  result: DecisionEngineResult;
  /** Contradiction flags extracted from result for top-level access. */
  contradictionFlags: ContradictionFlag[];
  /** Reason codes derived from buildDecisionReasonCodes. */
  reasonCodes: string[];
  /** Enriched trace reason mapping from buildDecisionTrace. */
  traceReasonMapping: TraceReasonEntry[];
  /** true if reason codes are semantically consistent with result.mode, false on mismatch. */
  parityValid: boolean;
}>;

export interface BuildAuditSnapshotOptions {
  /** Reason codes from buildDecisionReasonCodes. Defaults to []. */
  reasonCodes?: string[];
  /** Enriched trace reason entries. Defaults to []. */
  traceReasonMapping?: TraceReasonEntry[];
  /**
   * ISO 8601 timestamp override — useful for deterministic testing.
   * Defaults to new Date().toISOString() at call time.
   */
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that the provided reason codes are semantically consistent with the
 * execution mode. Mirrors the intent of assertReasonCodeParity in the decision
 * explanation module: throws an Error on parity violation, returns void on success.
 *
 * Parity rule: when reasonCodes is non-empty, at least one code must carry the
 * prefix that corresponds to the mode:
 *   blocked       → "BLOCKED_"
 *   preview_only  → "PREVIEW_"
 *   safe_to_apply → "SAFE_"
 */
function assertReasonCodeParity(
  mode: ExecutionMode,
  reasonCodes: string[]
): void {
  if (reasonCodes.length === 0) {
    return;
  }

  const modePrefixMap: Record<ExecutionMode, string> = {
    blocked: "BLOCKED_",
    preview_only: "PREVIEW_",
    safe_to_apply: "SAFE_",
  };

  const expectedPrefix = modePrefixMap[mode];
  const hasMatchingCode = reasonCodes.some((code) =>
    code.startsWith(expectedPrefix)
  );

  if (!hasMatchingCode) {
    throw new Error(
      `Reason code parity violation: mode "${mode}" expects at least one code ` +
        `prefixed with "${expectedPrefix}". Received: [${reasonCodes.join(", ")}]`
    );
  }
}

/**
 * Derives a deterministic, non-empty snapshotId from the serialized input and
 * the ISO timestamp. Uses base64 encoding and strips non-alphanumeric characters
 * to produce a compact, URL-safe identifier.
 */
function computeSnapshotId(
  input: DecisionEngineInput,
  timestamp: string
): string {
  const raw = JSON.stringify({
    timestamp,
    input,
  });

  return createHash("sha256").update(raw).digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a frozen, serializable AuditSnapshot that captures the full decision
 * moment in a single immutable object.
 *
 * The function is pure: identical inputs (including timestamp) always produce
 * structurally identical snapshots. Only the timestamp varies between calls
 * when not overridden.
 *
 * @param input   - The original engine input (riskScore, confidenceScore, mode).
 * @param result  - The full DecisionEngineResult including contradictionFlags.
 * @param options - Optional reason codes, trace mapping, and timestamp override.
 * @returns A frozen AuditSnapshot.
 */
export function buildAuditSnapshot(
  input: DecisionEngineInput,
  result: DecisionEngineResult,
  options: BuildAuditSnapshotOptions = {}
): AuditSnapshot {
  const timestamp = options.timestamp ?? new Date().toISOString();
  const reasonCodes = options.reasonCodes ?? [];
  const traceReasonMapping = options.traceReasonMapping ?? [];

  let parityValid: boolean;
  try {
    assertReasonCodeParity(result.mode, reasonCodes);
    parityValid = true;
  } catch {
    parityValid = false;
  }

  const snapshot: AuditSnapshot = {
    snapshotId: computeSnapshotId(input, timestamp),
    timestamp,
    input,
    result,
    contradictionFlags: result.contradictionFlags,
    reasonCodes,
    traceReasonMapping,
    parityValid,
  };

  return Object.freeze(snapshot);
}
