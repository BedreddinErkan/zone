import type {
  AgentExecutionResult,
  ConfidenceBreakdown,
  DecisionReason,
  PatchTargetSummary,
  ResultIssueGroup,
  ValidationIssue
} from "../types/agentResult.js";
import { scoreTopRisks } from "./scoreTopRisks.js";

function severityWeight(severity: "warning" | "error" | "info"): number {
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function normalizeIssueGroupKey(
  source?: ValidationIssue["source"],
  code?: string
)
    : ResultIssueGroup["key"] {
  if (source === "schema") return "schema";
  if (source === "confidence") return "confidence";
  if (source === "decision") return "decision";
  if (source === "architecture") return "architecture";
  if (source === "patch") return "validation";

  if (code?.startsWith("schema_")) return "schema";
  if (code?.startsWith("confidence_")) return "confidence";
  if (code?.startsWith("decision_")) return "decision";
  if (code?.startsWith("arch_")) return "architecture";

  return "other";
}

function getGroupLabel(key: ResultIssueGroup["key"]): string {
  switch (key) {
    case "validation":
      return "Validation";
    case "schema":
      return "Schema";
    case "confidence":
      return "Confidence";
    case "decision":
      return "Decision";
    case "architecture":
      return "Architecture";
    default:
      return "Other";
  }
}

export function sortIssuesBySeverity(input: ValidationIssue[]): ValidationIssue[] {
  return [...input].sort((a, b) => {
    const severityDiff = severityWeight(b.severity) - severityWeight(a.severity);
    if (severityDiff !== 0) return severityDiff;

    const sourceDiff = (a.source ?? "").localeCompare(b.source ?? "");
    if (sourceDiff !== 0) return sourceDiff;

    return a.code.localeCompare(b.code);
  });
}

export function countIssues(input: ValidationIssue[]): {
  total: number;
  errors: number;
  warnings: number;
} {
  const errors = input.filter((item) => item.severity === "error").length;
  const warnings = input.filter((item) => item.severity === "warning").length;

  return {
    total: input.length,
    errors,
    warnings
  };
}

export function groupIssues(input: ValidationIssue[]): ResultIssueGroup[] {
  const buckets = new Map<ResultIssueGroup["key"], ValidationIssue[]>();

  for (const issue of input) {
    const key = normalizeIssueGroupKey(issue.source, issue.code);
    const items = buckets.get(key) ?? [];
    items.push(issue);
    buckets.set(key, items);
  }

  return Array.from(buckets.entries())
    .map(([key, issues]) => {
      const sorted = sortIssuesBySeverity(issues);

      return {
        key,
        label: getGroupLabel(key),
        total: sorted.length,
        errors: sorted.filter((item) => item.severity === "error").length,
        warnings: sorted.filter((item) => item.severity === "warning").length,
        issues: sorted
      };
    })
    .sort((a, b) => {
      if (a.errors !== b.errors) return b.errors - a.errors;
      if (a.warnings !== b.warnings) return b.warnings - a.warnings;
      return a.label.localeCompare(b.label);
    });
}

export function buildExecutionResult(input: {
  runId: string;
  rawTask: string;
  normalizedTask?: string;
  targetPath: string;
  diffAware?: boolean;
  mode: "preview" | "dry-run" | "apply";
  ci: boolean;
  decisionMode: AgentExecutionResult["decision"]["mode"];
  recommendation: string;
  reasons: DecisionReason[];
  confidenceBreakdown: ConfidenceBreakdown;
  issues: ValidationIssue[];
  patchTargets?: PatchTargetSummary[];
  suggestedFiles?: string[];
  notes?: string[];
}): AgentExecutionResult {
  const sortedIssues = sortIssuesBySeverity(input.issues);
  const counts = countIssues(sortedIssues);

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    runId: input.runId,
    task: {
      raw: input.rawTask,
      normalized: input.normalizedTask
    },
    project: {
      targetPath: input.targetPath,
      diffAware: input.diffAware,
      mode: input.mode,
      ci: input.ci
    },
    decision: {
      mode: input.decisionMode,
      recommendation: input.recommendation,
      reasons: input.reasons
    },
    confidence: {
      score: input.confidenceBreakdown.score,
      breakdown: input.confidenceBreakdown
    },
    issues: {
      ...counts,
      items: sortedIssues,
      groups: groupIssues(sortedIssues),
      topRisks: scoreTopRisks({
        issues: sortedIssues,
        decisionMode: input.decisionMode,
        limit: 5
      })
    },
    patch: input.patchTargets
      ? {
          totalTargets: input.patchTargets.length,
          targets: input.patchTargets
        }
      : undefined,
    debug: {
      suggestedFiles: input.suggestedFiles,
      notes: input.notes
    }
  };
}