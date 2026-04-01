export type AgentDecisionMode = "blocked" | "preview_only" | "safe_to_apply";

export type ConfidencePenalty = {
  code: string;
  reason: string;
  points: number;
};

export type ConfidenceBreakdown = {
  baseScore: number;
  finalScore: number;
  penalties: ConfidencePenalty[];
};

export type SuggestedFileAction = "create" | "modify" | "inspect" | "delete";

export type SuggestedFile = {
  path: string;
  action: SuggestedFileAction;
  reason: string;
  exists?: boolean;
  verified?: boolean;
};

export type PatchOperation = "create" | "update" | "delete";

export type PatchPreviewItem = {
  path: string;
  operation: PatchOperation;
  summary?: string;
  diffPreview?: string;
};

export type ValidationIssueLevel = "info" | "warning" | "error";

export type ValidationIssue = {
  code: string;
  message: string;
  level: ValidationIssueLevel;
  path?: string;
};

export type RiskLevel = "low" | "medium" | "high";

export type PatchRiskSummary = {
  overallRisk: RiskLevel;
  reasons: string[];
};

export type AgentExecutionMeta = {
  task: string;
  repoPath: string;
  ci: boolean;
  verbose: boolean;
  diffAware: boolean;
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type AgentResult = {
  decisionMode: AgentDecisionMode;

  confidenceScore: number;
  confidence: ConfidenceBreakdown;

  implementationSummary?: string;
  steps?: string[];

  suggestedFiles?: SuggestedFile[];
  validatedSuggestedFiles?: SuggestedFile[];

  patchPreview?: PatchPreviewItem[];

  architectureValidation?: {
    passed: boolean;
    issues: ValidationIssue[];
  };

  patchRisk?: PatchRiskSummary;

  patchValidation?: {
    passed: boolean;
    issues: ValidationIssue[];
  };

  ciEvaluation?: {
    status: "pass" | "warn" | "fail";
    shouldFail: boolean;
    statusLine: string;
    summaryLine: string;
  };

  warnings?: string[];
  errors?: string[];

  meta: AgentExecutionMeta;
};