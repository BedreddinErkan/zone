export type ConfidenceSeverity = "info" | "warning" | "critical";

export interface ConfidenceFactor {
  key: string;
  label: string;
  impact: number;
  severity: ConfidenceSeverity;
  reason: string;
}

export interface ConfidenceSummary {
  totalPenalty: number;
  totalBonus: number;
  hasCriticalRisk: boolean;
}

export interface ConfidenceBreakdown {
  baseScore: number;
  finalScore: number;
  factors: ConfidenceFactor[];
  summary: ConfidenceSummary;
}

export interface ComputeConfidenceBreakdownInput {
  schemaConfidence: number;
  storageConfidence: number;
  architectureWarnings?: string[];
  patchRiskWarnings?: string[];
  validationErrors?: string[];
  hasValidatedFiles: boolean;
  role?: "test_engineer" | "developer" | "data_analyst";
}

export const CONFIDENCE_RULES = {
  baseScore: 100,

  schemaPenaltyBands: [
    {
      maxExclusive: 40,
      impact: -30,
      severity: "critical" as const,
      label: "Schema confidence very low",
    },
    {
      maxExclusive: 60,
      impact: -18,
      severity: "warning" as const,
      label: "Schema confidence low",
    },
    {
      maxExclusive: 75,
      impact: -10,
      severity: "warning" as const,
      label: "Schema confidence slightly below safe threshold",
    },
  ],

  storagePenaltyBands: [
    {
      maxExclusive: 40,
      impact: -25,
      severity: "critical" as const,
      label: "Storage confidence very low",
    },
    {
      maxExclusive: 60,
      impact: -15,
      severity: "warning" as const,
      label: "Storage confidence low",
    },
    {
      maxExclusive: 75,
      impact: -8,
      severity: "warning" as const,
      label: "Storage confidence slightly below safe threshold",
    },
  ],

  missingValidatedFilesPenalty: {
    impact: -20,
    severity: "warning" as const,
    label: "No validated files found",
  },

  architectureWarningPenaltyPerItem: -6,
  architectureWarningPenaltyCap: -18,

  patchRiskWarningPenaltyPerItem: -8,
  patchRiskWarningPenaltyCap: -24,

  validationErrorPenaltyPerItem: -40,
  validationErrorPenaltyCap: -80,

  roleValidationErrorMultipliers: {
    data_analyst: 1.5,
    developer: 1.0,
    test_engineer: 0.7,
  } as const,
} as const;
