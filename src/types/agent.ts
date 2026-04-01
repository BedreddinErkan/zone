import type { ProjectStructure, RepoFile } from "./project.js";
import type { TaskIntent } from "../core/taskIntentParser.js";

export interface FeatureAgentInput {
  task: string;
  targetPath: string;
  mode?: "preview" | "dry-run" | "apply";
  changedFiles?: string[];
}

export interface PlannedFileChange {
  path: string;
  reason: string;
  action: "create" | "modify" | "inspect";
}

export interface LlmFeaturePlan {
  implementationSummary: string;
  steps: string[];
  suggestedFiles: PlannedFileChange[];
  risks: string[];
}

export interface ValidatedSuggestedFile {
  originalPath: string;
  resolvedPath: string | null;
  action: "create" | "modify" | "inspect";
  reason: string;
  status: "verified" | "corrected" | "missing";
}

export interface PatchPreviewItem {
  path: string;
  operation: "create" | "modify";
  summary: string;
  targetHint: string;
  contentPreview: string;
}

export interface LlmPatchPlan {
  summary: string;
  patches: PatchPreviewItem[];
  warnings: string[];
}

export interface ApplyResultItem {
  path: string;
  action: "created" | "patched-file-generated" | "skipped";
  outputPath?: string;
  reason: string;
}

export interface RankedRepoFile extends RepoFile {
  score: number;
}

export type ValidationSeverity = "info" | "warning" | "error";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface ValidationIssue {
  code: string;
  message: string;
  severity: ValidationSeverity;
  file?: string;
  details?: string;
}

export interface SchemaAwareSummary {
  summary: string;
  entities: string[];
  relations: string[];
  confidence: ConfidenceLevel;
}

export interface StorageInsight {
  primaryStorage:
    | "postgres"
    | "mongodb"
    | "mysql"
    | "sqlite"
    | "supabase"
    | "prisma"
    | "filesystem"
    | "unknown";
  resourceStorageKind?: "separate_table" | "json_field" | "unknown";
  detectedClients: string[];
  reasoning: string[];
  confidence: ConfidenceLevel;
}

export interface ExecutionNotes {
  notes: string[];
  assumptions: string[];
  followUps: string[];
}

export interface ConfidenceBreakdown {
  intentClarity: number;
  schemaCertainty: number;
  storageCertainty: number;
  patchValidationHealth: number;
  finalScore: number;
}

export interface ConfidencePenaltyItem {
  code: string;
  label: string;
  count?: number;
  perItem?: number;
  cap?: number;
  appliedPenalty: number;
}

export interface ConfidenceDetails {
  baseWeightedScore: number;
  totalPenalty: number;
  penalties: ConfidencePenaltyItem[];
}

export type AgentDecisionMode = "safe_to_apply" | "preview_only" | "blocked";
export type SavedDecisionMode = "apply" | "preview" | "blocked";

export interface AgentDecision {
  mode: AgentDecisionMode;
  confidenceScore: number;
  reason: string;
}

export interface FeatureAgentResult {
  task: string;
  targetPath: string;
  structure: ProjectStructure;
  allFiles: RepoFile[];
  relevantFiles: RankedRepoFile[];
  summary: string;

  llmPlan: LlmFeaturePlan;
  validatedSuggestedFiles: ValidatedSuggestedFile[];
  patchPlan: LlmPatchPlan;

  intent: TaskIntent;
  architectureWarnings: string[];
  patchRiskWarnings: string[];

  schemaAwareSummary: SchemaAwareSummary;
  storageInsight: StorageInsight;
  patchValidationIssues: ValidationIssue[];
  schemaPatchWarnings: ValidationIssue[];
  executionNotes: ExecutionNotes;
  confidence: ConfidenceBreakdown;
  confidenceDetails: ConfidenceDetails;
  decision: AgentDecision;

  applyResults?: ApplyResultItem[];
}

export interface SavedAgentResult {
  summary: string;

  intent: {
    rawTask: string;
    operation: string;
    target: string;
    scope?: string;
    nestedTarget?: string | null;
    confidence?: ConfidenceLevel;
  };

  schema: {
    summary?: string;
    entities: string[];
    relations: string[];
    confidence?: ConfidenceLevel;
  };

  storage: {
    primaryStorage: string;
    detectedClients: string[];
    confidence?: ConfidenceLevel;
    reasoning: string[];
  };

  validation: {
    patch: ValidationIssue[];
    schema: ValidationIssue[];
  };

  decision: {
    mode: SavedDecisionMode;
    confidence: number;
    reason: string;
  };

  confidenceDetails: {
    baseWeightedScore: number;
    totalPenalty: number;
    penalties: ConfidencePenaltyItem[];
  };

  notes: {
    execution: string[];
    assumptions: string[];
    followUps: string[];
  };

  statusLine: string;
}

export type CiOutcome = "pass" | "warn" | "fail";

export interface CiEvaluationResult {
  outcome: CiOutcome;
  exitCode: number;
  shouldFail: boolean;
  title: string;
  summary: string;
  annotations: string[];
}