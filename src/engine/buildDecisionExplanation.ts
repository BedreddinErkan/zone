import { DECISION_REASON_CODE_META } from "../core/decision/decisionReasonCodeMeta.js";

// ---------------------------------------------------------------------------
// Fallback constants — deterministic, documented, all string literals
// ---------------------------------------------------------------------------

/** Applied when the caller provides null, undefined, or an empty reasonCodes array. */
const WHY_EMPTY_CODES = "No reason codes provided";

/** Applied when every supplied code is unknown (not found in the metadata registry). */
const WHY_NO_VALID_CODES = "No valid reason codes resolved";

/** Fallback when a metadata entry exists but its severity field is missing or unrecognised. */
const FALLBACK_SEVERITY = "info" as const;

/** Fallback when a metadata entry exists but its category field is missing or empty. */
const FALLBACK_CATEGORY = "general";

/** Fallback when a metadata entry exists but its summary field is missing or empty. */
const FALLBACK_SUMMARY = "No summary available";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResolvedReasonSeverity = "info" | "warning" | "critical";

export type ResolvedReason = {
  /** The original reason code string. */
  code: string;
  /** Normalised severity — never null or undefined in output. */
  severity: ResolvedReasonSeverity;
  /** Reason category — never null or undefined in output. */
  category: string;
  /** Human-readable explanation — never null or undefined in output. */
  summary: string;
};

export type DecisionExplanation = {
  /** A single human-readable sentence summarising the outcome. */
  why: string;
  /** Fully resolved and normalised reason entries. Always an array, never undefined. */
  reasons: ResolvedReason[];
};

export type BuildDecisionExplanationInput = {
  /**
   * Reason codes to resolve against the metadata registry.
   * null and undefined are accepted and treated as an empty array.
   */
  reasonCodes: string[] | null | undefined;
};

/**
 * Partial metadata shape used for optional injection during testing.
 * Mirrors the fields consumed from the real registry, all made optional
 * so tests can exercise individual missing-field fallback paths.
 */
export type PartialReasonMeta = {
  severity?: string | null | undefined;
  category?: string | null | undefined;
  summary?: string | null | undefined;
};

export type BuildDecisionExplanationOptions = {
  /**
   * Optional metadata registry override.
   * When provided, replaces the default DECISION_REASON_CODE_META for this call.
   * Intended for test injection of partial/missing metadata entries.
   * The normal production path never needs to pass this.
   */
  metadata?: Record<string, PartialReasonMeta>;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalises raw metadata severity (the registry's "low" | "medium" | "high" scale)
 * to the engine's three-level severity scale ("info" | "warning" | "critical").
 *
 * Missing or unrecognised severity → FALLBACK_SEVERITY ("info").
 */
function resolveReasonSeverity(
  raw: string | null | undefined
): ResolvedReasonSeverity {
  // Missing severity → default to "info" (documented fallback, no throw)
  if (!raw) return FALLBACK_SEVERITY;

  switch (raw) {
    case "high":
      return "critical";
    case "medium":
      return "warning";
    case "low":
      return "info";
    default:
      // Unknown severity string → safe default, no throw
      return FALLBACK_SEVERITY;
  }
}

/**
 * Builds the "why" summary string for a successful explanation (≥1 resolved reason).
 * Lists the count and the code identifiers for full traceability.
 */
function buildWhyFromReasons(reasons: ResolvedReason[]): string {
  const count = reasons.length;
  const codeList = reasons.map((r) => r.code).join(", ");
  return `Decision backed by ${count} reason code(s): ${codeList}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a deterministic, fully-populated DecisionExplanation from an array of
 * reason codes.
 *
 * Edge-case guarantees — all silent (no throws, no console output):
 *
 *   • null / undefined reasonCodes  → treated as []
 *   • empty reasonCodes             → { why: "No reason codes provided", reasons: [] }
 *   • unknown code (not in registry)→ skipped silently; never throws
 *   • all codes unknown             → { why: "No valid reason codes resolved", reasons: [] }
 *   • missing severity in metadata  → defaults to "info"
 *   • missing category in metadata  → defaults to "general"
 *   • missing summary in metadata   → defaults to "No summary available"
 *
 * The output object is always complete: every field is a non-null, non-undefined
 * string or array. The normal production path is completely unaffected by the
 * fallback handling — it only activates on genuinely missing data.
 *
 * @param input   - Object containing the reasonCodes to resolve.
 * @param options - Optional: metadata registry override for test injection.
 * @returns A fully-populated DecisionExplanation.
 */
export function buildDecisionExplanation(
  input: BuildDecisionExplanationInput,
  options: BuildDecisionExplanationOptions = {}
): DecisionExplanation {
  // Normalise null / undefined → [] (silent, no throw)
  const rawCodes = input.reasonCodes ?? [];

  // Empty input → early return with documented fallback why
  if (rawCodes.length === 0) {
    return { why: WHY_EMPTY_CODES, reasons: [] };
  }

  // Resolve metadata source: injected override takes precedence over the default registry
  const metaRegistry: Record<string, PartialReasonMeta> =
    options.metadata ??
    (DECISION_REASON_CODE_META as Record<string, PartialReasonMeta>);

  const reasons: ResolvedReason[] = [];

  for (const code of rawCodes) {
    // Unknown code — not present in registry → skip silently, do NOT throw
    const meta = metaRegistry[code];
    if (!meta) continue;

    const resolved: ResolvedReason = {
      code,
      // Missing severity → default to "info"
      severity: resolveReasonSeverity(meta.severity),
      // Missing category → default to "general"
      category:
        typeof meta.category === "string" && meta.category.length > 0
          ? meta.category
          : FALLBACK_CATEGORY,
      // Missing summary → default to "No summary available"
      summary:
        typeof meta.summary === "string" && meta.summary.length > 0
          ? meta.summary
          : FALLBACK_SUMMARY,
    };

    reasons.push(resolved);
  }

  // Every supplied code was unknown → fallback why
  if (reasons.length === 0) {
    return { why: WHY_NO_VALID_CODES, reasons: [] };
  }

  return { why: buildWhyFromReasons(reasons), reasons };
}
