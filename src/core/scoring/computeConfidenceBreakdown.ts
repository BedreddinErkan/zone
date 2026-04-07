import {
  CONFIDENCE_RULES,
  type ComputeConfidenceBreakdownInput,
  type ConfidenceBreakdown,
  type ConfidenceFactor,
} from "./confidenceRules.js";

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return clampNumber(Math.round(value), 0, 100);
}

function buildBandPenalty(params: {
  key: string;
  value: number;
  bands: ReadonlyArray<{
    maxExclusive: number;
    impact: number;
    severity: "warning" | "critical";
    label: string;
  }>;
  confidenceType: "schema" | "storage";
}): ConfidenceFactor[] {
  const normalizedValue = normalizeConfidence(params.value);

  const matchedBand = params.bands.find(
    (band) => normalizedValue < band.maxExclusive
  );

  if (!matchedBand) {
    return [];
  }

  return [
    {
      key: params.key,
      label: matchedBand.label,
      impact: matchedBand.impact,
      severity: matchedBand.severity,
      reason: `${params.confidenceType} confidence is ${normalizedValue}, which falls below the safe threshold.`,
    },
  ];
}

function buildMissingValidatedFilesPenalty(
  hasValidatedFiles: boolean
): ConfidenceFactor[] {
  if (hasValidatedFiles) {
    return [];
  }

  return [
    {
      key: "missing_validated_files",
      label: CONFIDENCE_RULES.missingValidatedFilesPenalty.label,
      impact: CONFIDENCE_RULES.missingValidatedFilesPenalty.impact,
      severity: CONFIDENCE_RULES.missingValidatedFilesPenalty.severity,
      reason:
        "No validated files were identified, so patch targeting confidence is reduced.",
    },
  ];
}

function buildRepeatedWarningPenalty(params: {
  key: string;
  label: string;
  warnings: string[];
  penaltyPerItem: number;
  penaltyCap: number;
  reasonPrefix: string;
}): ConfidenceFactor[] {
  if (params.warnings.length === 0) {
    return [];
  }

  const rawPenalty = params.warnings.length * params.penaltyPerItem;
  const finalPenalty = Math.max(rawPenalty, params.penaltyCap);

  return [
    {
      key: params.key,
      label: params.label,
      impact: finalPenalty,
      severity: "warning",
      reason: `${params.reasonPrefix}: ${params.warnings.join("; ")}`,
    },
  ];
}

function buildValidationErrorPenalty(
  validationErrors: string[],
  role?: "test_engineer" | "developer" | "data_analyst"
): ConfidenceFactor[] {
  if (validationErrors.length === 0) {
    return [];
  }

  const multiplier = role
    ? CONFIDENCE_RULES.roleValidationErrorMultipliers[role]
    : 1.0;
  const rawPenalty =
    validationErrors.length *
    CONFIDENCE_RULES.validationErrorPenaltyPerItem *
    multiplier;
  const finalPenalty = Math.max(
    rawPenalty,
    CONFIDENCE_RULES.validationErrorPenaltyCap
  );

  return [
    {
      key: "validation_errors",
      label: "Validation errors detected",
      impact: finalPenalty,
      severity: "critical",
      reason: `Validation errors reduce execution confidence: ${validationErrors.join(
        "; "
      )}`,
    },
  ];
}

export function computeConfidenceBreakdown(
  input: ComputeConfidenceBreakdownInput
): ConfidenceBreakdown {
  const architectureWarnings = input.architectureWarnings ?? [];
  const patchRiskWarnings = input.patchRiskWarnings ?? [];
  const validationErrors = input.validationErrors ?? [];

  const factors: ConfidenceFactor[] = [
    ...buildBandPenalty({
      key: "schema_confidence",
      value: input.schemaConfidence,
      bands: CONFIDENCE_RULES.schemaPenaltyBands,
      confidenceType: "schema",
    }),
    ...buildBandPenalty({
      key: "storage_confidence",
      value: input.storageConfidence,
      bands: CONFIDENCE_RULES.storagePenaltyBands,
      confidenceType: "storage",
    }),
    ...buildMissingValidatedFilesPenalty(input.hasValidatedFiles),
    ...buildRepeatedWarningPenalty({
      key: "architecture_warnings",
      label: "Architecture warnings detected",
      warnings: architectureWarnings,
      penaltyPerItem: CONFIDENCE_RULES.architectureWarningPenaltyPerItem,
      penaltyCap: CONFIDENCE_RULES.architectureWarningPenaltyCap,
      reasonPrefix: "Architecture concerns identified",
    }),
    ...buildRepeatedWarningPenalty({
      key: "patch_risk_warnings",
      label: "Patch risk warnings detected",
      warnings: patchRiskWarnings,
      penaltyPerItem: CONFIDENCE_RULES.patchRiskWarningPenaltyPerItem,
      penaltyCap: CONFIDENCE_RULES.patchRiskWarningPenaltyCap,
      reasonPrefix: "Patch risk concerns identified",
    }),
    ...buildValidationErrorPenalty(validationErrors, input.role),
  ];

  const totalPenalty = factors
    .filter((factor) => factor.impact < 0)
    .reduce((sum, factor) => sum + Math.abs(factor.impact), 0);

  const totalBonus = factors
    .filter((factor) => factor.impact > 0)
    .reduce((sum, factor) => sum + factor.impact, 0);

  const finalScore = clampNumber(
    CONFIDENCE_RULES.baseScore - totalPenalty + totalBonus,
    0,
    100
  );

  return {
    baseScore: CONFIDENCE_RULES.baseScore,
    finalScore,
    factors,
    summary: {
      totalPenalty,
      totalBonus,
      hasCriticalRisk: factors.some((factor) => factor.severity === "critical"),
    },
  };
}
