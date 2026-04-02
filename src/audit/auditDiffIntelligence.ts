export type DiffChangeType =
  | "mode_flip"
  | "confidence_shift"
  | "risk_shift"
  | "parity_regression"
  | "reasoning_change"
  | "contradiction_introduced";

export type DiffSeverity = "low" | "medium" | "high" | "critical";

export type DiffClassification = {
  type: DiffChangeType;
  description: string;
};

export type ClassifiedAuditDiff = {
  classifications: DiffClassification[];
  severity: DiffSeverity;
};