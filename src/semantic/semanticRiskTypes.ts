export type SemanticRiskSeverity = "low" | "medium" | "high" | "critical";

export type SemanticRiskCategory =
  | "auth"
  | "authorization"
  | "secrets"
  | "tests"
  | "validation"
  | "database"
  | "logging"
  | "safety_guard";

export type SemanticRiskCode =
  | "AUTH_GUARD_REMOVED"
  | "ROLE_CHECK_REMOVED"
  | "SECRET_EXPOSED_TO_LOG"
  | "TEST_ASSERTION_REMOVED"
  | "VALIDATION_REMOVED"
  | "RATE_LIMIT_REMOVED"
  | "BROAD_ERROR_SWALLOWING";

export type SemanticRiskEvidence = {
  beforeMatches?: string[];
  afterMatches?: string[];
  details?: string;
};

export type SemanticRisk = {
  code: SemanticRiskCode;
  severity: SemanticRiskSeverity;
  category: SemanticRiskCategory;
  message: string;
  filePath: string;
  evidence?: SemanticRiskEvidence;
};

export type DetectSemanticRiskInput = {
  filePath: string;
  beforeContent: string;
  afterContent: string;
  diffLines?: string[];
};

export type SemanticRiskRule = (
  input: DetectSemanticRiskInput
) => SemanticRisk[];

export type SemanticRiskScore = {
  totalScore: number;
  highestSeverity: SemanticRiskSeverity;
  countsBySeverity: Record<SemanticRiskSeverity, number>;
};
