export type { ScoredRisk } from "../../types/agent.js";
import type { ScoredRisk } from "../../types/agent.js";
export type AgentDecisionMode = "blocked" | "preview_only" | "safe_to_apply";

export type ReasonSeverity = "info" | "warning" | "error";
// YENİ HAL
export interface ValidationIssue {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  source?: "schema" | "confidence" | "decision" | "architecture" | "patch"; // ← bu satırı ekle
}
export interface DecisionReason {
  code: string;
  severity: ReasonSeverity;
  message: string;
  details?: string[];
}

export interface ConfidenceFactor {
  key: string;
  label: string;
  impact: number;
  reason?: string;
}

export interface ConfidenceBreakdown {
  score: number;
  factors: ConfidenceFactor[];
  summary?: string;
}

export interface PatchTargetSummary {
  path: string;
  operation: "create" | "update" | "delete";
}

export interface ResultIssueGroup {
  key: "validation" | "schema" | "confidence" | "decision" | "architecture" | "other";
  label: string;
  total: number;
  errors: number;
  warnings: number;
  issues: ValidationIssue[];
}

export interface AgentExecutionResult {
  version: 2;
  generatedAt: string;
  runId: string;

  task: {
    raw: string;
    normalized?: string;
  };

  project: {
    targetPath: string;
    diffAware?: boolean;
    mode: "preview" | "dry-run" | "apply";
    ci: boolean;
  };

  decision: {
    mode: AgentDecisionMode;
    recommendation: string;
    reasons: DecisionReason[];
  };

  confidence: {
    score: number;
    breakdown: ConfidenceBreakdown;
  };

  issues: {
    total: number;
    errors: number;
    warnings: number;
    items: ValidationIssue[];
    groups: ResultIssueGroup[];
    topRisks: ScoredRisk[];
  };

  patch?: {
    totalTargets: number;
    targets: PatchTargetSummary[];
  };

  debug?: {
    suggestedFiles?: string[];
    notes?: string[];
  };
}