export type PatchIntentType =
  | "micro_edit"
  | "style_change"
  | "bug_fix"
  | "feature_add"
  | "refactor"
  | "test_add"
  | "config_change"
  | "unknown";

/** @deprecated Use PatchIntentType */
export type IntentType = PatchIntentType;

export type ScopeRating = "clean" | "borderline" | "overshooting" | "critical";

export interface ScopeLimits {
  warnLines: number;
  maxLines: number;
  warnFiles: number;
  maxFiles: number;
}

export interface ScopeViolation {
  field: "totalChangedLines" | "changedFileCount";
  kind: "soft" | "hard";
  limit: number;
  actual: number;
  message: string;
}

export interface PatchScopeValidatorResult {
  violations: ScopeViolation[];
  hasHardViolation: boolean;
  hasSoftViolation: boolean;
  confidencePenalty: number;
  scopeRating: ScopeRating;
}

const SCOPE_LIMITS: Record<IntentType, ScopeLimits> = {
  micro_edit:    { warnLines: 10,  maxLines: 25,  warnFiles: 1, maxFiles: 2  },
  style_change:  { warnLines: 50,  maxLines: 120, warnFiles: 3, maxFiles: 8  },
  bug_fix:       { warnLines: 60,  maxLines: 150, warnFiles: 3, maxFiles: 6  },
  feature_add:   { warnLines: 200, maxLines: 500, warnFiles: 8, maxFiles: 20 },
  refactor:      { warnLines: 150, maxLines: 400, warnFiles: 6, maxFiles: 15 },
  test_add:      { warnLines: 100, maxLines: 250, warnFiles: 4, maxFiles: 10 },
  config_change: { warnLines: 20,  maxLines: 60,  warnFiles: 2, maxFiles: 5  },
  unknown: { warnLines: 50, maxLines: 100, warnFiles: 3, maxFiles: 5 },
};

export function validatePatchScope(
  intentType: IntentType,
  totalChangedLines: number,
  changedFileCount: number
): PatchScopeValidatorResult {
  const limits = SCOPE_LIMITS[intentType];
  const violations: ScopeViolation[] = [];

  // --- Line count checks ---
  if (totalChangedLines > limits.maxLines) {
    violations.push({
      field: "totalChangedLines",
      kind: "hard",
      limit: limits.maxLines,
      actual: totalChangedLines,
      message: `Changed lines (${totalChangedLines}) exceed the hard maximum of ${limits.maxLines} for intent "${intentType}".`,
    });
  } else if (totalChangedLines > limits.warnLines) {
    violations.push({
      field: "totalChangedLines",
      kind: "soft",
      limit: limits.warnLines,
      actual: totalChangedLines,
      message: `Changed lines (${totalChangedLines}) exceed the soft warning of ${limits.warnLines} for intent "${intentType}".`,
    });
  }

  // --- File count checks ---
  if (changedFileCount > limits.maxFiles) {
    violations.push({
      field: "changedFileCount",
      kind: "hard",
      limit: limits.maxFiles,
      actual: changedFileCount,
      message: `Changed files (${changedFileCount}) exceed the hard maximum of ${limits.maxFiles} for intent "${intentType}".`,
    });
  } else if (changedFileCount > limits.warnFiles) {
    violations.push({
      field: "changedFileCount",
      kind: "soft",
      limit: limits.warnFiles,
      actual: changedFileCount,
      message: `Changed files (${changedFileCount}) exceed the soft warning of ${limits.warnFiles} for intent "${intentType}".`,
    });
  }

  const hasHardViolation = violations.some((v) => v.kind === "hard");
  const hasSoftViolation = violations.some((v) => v.kind === "soft");
  const softCount = violations.filter((v) => v.kind === "soft").length;
  const hardCount = violations.filter((v) => v.kind === "hard").length;

  // Penalty: 20 per hard violation (max 40), 10 per soft violation (max 20), capped at 40
  const rawPenalty = hardCount * 20 + softCount * 10;
  const confidencePenalty = Math.min(rawPenalty, 40) as number;

  // Scope rating
  let scopeRating: ScopeRating;
  if (hardCount >= 2) {
    scopeRating = "critical";
  } else if (hardCount === 1) {
    scopeRating = "overshooting";
  } else if (softCount > 0) {
    scopeRating = "borderline";
  } else {
    scopeRating = "clean";
  }

  return {
    violations,
    hasHardViolation,
    hasSoftViolation,
    confidencePenalty,
    scopeRating,
  };
}
