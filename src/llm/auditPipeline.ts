/**
 * Transport-agnostic scope audit pipeline extracted from server.ts.
 * Callers supply an `emit` callback so the pipeline can be used in both
 * the HTTP (SSE) path and the TUI (EventBus) path without duplication.
 */

import { shouldRunAudit as computeAuditDecision, isLowRiskPlan, type AuditMode } from "./auditMode.js";
import { TIER_LIMITS } from "./tierLimits.js";
import { investigateScope } from "./investigationFlow.js";
import { runScopeJudge } from "./scopeJudge.js";
import {
  requestRevisionApproval,
  type RevisionProposal,
  type RevisionDecision,
} from "./revisionApprovals.js";
import { generateExecutionPlan } from "./executionPlan.js";
import { log } from "../utils/logger.js";
import type { TaskClassification, TaskTier } from "./taskClassifier.js";
import type { buildPipelineConfig } from "./archetypeDispatcher.js";

export interface AuditFindingsForExec {
  summary: string;
  citationCount: number;
  toolCallCount: number;
  costUsd: number;
  scopeVerdict?: "under_scope" | "over_scope" | "mixed" | "none";
  severity?: "none" | "minor" | "major";
  citations?: Array<{ file: string; line?: number }>;
  filesAlreadyRead?: string[];
  rootCause?: string;
  fixInstruction?: string;
  filesToEdit?: string[];
  evidence?: string;
}

export interface AuditPipelineInput {
  task: string;
  repoPath: string;
  runId: string;
  tier: TaskTier;
  auditMode: AuditMode;
  /** When true, forces audit to run — but still skips if isLowRiskPlan returns true (Q3). */
  forceAudit: boolean;
  preClassifiedTask?: TaskClassification | null;
  preGeneratedPlan?: Awaited<ReturnType<typeof generateExecutionPlan>> | null;
  userApiKey?: string;
  /** Callback for all audit lifecycle events + sub-investigation progress. */
  emit: (update: { stage: string; progress?: unknown }) => void;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  autoApprove?: boolean;
  isHeadless?: boolean;
  pipelineCfg?: ReturnType<typeof buildPipelineConfig>;
}

export interface AuditPipelineResult {
  auditFindings?: AuditFindingsForExec;
  revisionDecision?: RevisionDecision;
  earlyExit?: { terminationReason: string; proposal: RevisionProposal; revisionId: string } | null;
}

export async function runAuditPipeline(input: AuditPipelineInput): Promise<AuditPipelineResult> {
  const { runId, tier, auditMode, pipelineCfg } = input;

  // Q3: forceAudit=true still respects the low-risk-plan skip to avoid wasting tokens
  // on trivial plans. explicitRequest is true only when forceAudit AND not low-risk.
  const skipDueToLowRisk = input.forceAudit &&
    isLowRiskPlan(input.preGeneratedPlan, input.preClassifiedTask ?? null);
  const auditDecision = skipDueToLowRisk
    ? { shouldRun: false as const, reason: "low_risk_plan" }
    : computeAuditDecision({
        tier,
        auditMode,
        explicitRequest: input.forceAudit,
        plan: input.preGeneratedPlan ?? null,
        classification: input.preClassifiedTask ?? null,
        runId,
      });

  if (!auditDecision.shouldRun
      || pipelineCfg?.skipAudit
      || pipelineCfg?.skipPhase1) {
    log("[zone-audit-skipped]", JSON.stringify({
      runId,
      tier,
      auditMode,
      reason: auditDecision.reason,
      ts: new Date().toISOString(),
    }));
    return {};
  }

  if (!input.preGeneratedPlan) {
    log("[zone-audit-skipped]", JSON.stringify({
      runId,
      tier,
      auditMode,
      reason: "no_plan",
      ts: new Date().toISOString(),
    }));
    return {};
  }

  const preGeneratedPlan = input.preGeneratedPlan;
  let auditFindings: AuditFindingsForExec | undefined;
  let revisionDecision: RevisionDecision | undefined;
  let earlyExit: AuditPipelineResult["earlyExit"] = null;

  try {
    input.emit({
      stage: "scope_revision",
      progress: {
        runId,
        ts: Date.now(),
        type: "scope_audit_started",
        title: "Auditing plan scope",
        status: "active",
      },
    });

    const findings = await investigateScope({
      repoPath: input.repoPath,
      query: `Audit whether this plan is correctly scoped for the task:\n\n${input.task}\n\nPlan:\n${preGeneratedPlan.objective}\nSteps: ${preGeneratedPlan.steps.map((s) => s.title).join(", ")}`,
      runId,
      userApiKey: input.userApiKey,
      abortSignal: input.abortSignal,
      parentTier: tier,
      maxIterationsOverride: TIER_LIMITS[tier].auditIterCap,
      onProgress: (update) => input.emit(update),
    });

    if (findings.skipped) {
      input.emit({
        stage: "scope_revision",
        progress: {
          runId,
          ts: Date.now(),
          type: "scope_audit_skipped",
          title: "Scope audit skipped",
          skipReason: findings.skipReason,
          status: "warning",
        },
      });
    } else {
      auditFindings = {
        summary: findings.findings.slice(0, 2048),
        citationCount: findings.citations.length,
        toolCallCount: findings.toolCallCount,
        costUsd: findings.costUsd,
        ...(findings.citations.length ? { citations: findings.citations } : {}),
        ...(findings.filesAlreadyRead?.length ? { filesAlreadyRead: findings.filesAlreadyRead } : {}),
        ...(findings.rootCause ? { rootCause: findings.rootCause } : {}),
        ...(findings.fixInstruction ? { fixInstruction: findings.fixInstruction } : {}),
        ...(findings.filesToEdit?.length ? { filesToEdit: findings.filesToEdit } : {}),
        ...(findings.evidence ? { evidence: findings.evidence } : {}),
      };

      const agentRevision = findings.agentSuggestedRevision;
      const judgement = await runScopeJudge({
        originalPlan: preGeneratedPlan,
        findings: findings.findings,
        taskClassification: input.preClassifiedTask ?? undefined,
        runId,
        userApiKey: input.userApiKey,
      });
      auditFindings.scopeVerdict = judgement.type;
      auditFindings.severity = judgement.severity;

      const hasMismatch = agentRevision != null || judgement.mismatch;
      if (hasMismatch) {
        const revType = agentRevision?.type ?? judgement.type as "under_scope" | "over_scope" | "mixed";
        const revReason = agentRevision?.reason ?? judgement.reason;
        const revSummary = agentRevision?.revisedPlanSummary ?? judgement.revisedPlan ?? "Revised plan — see reason above.";
        const revMissing = agentRevision?.missingFiles ?? judgement.missingFiles;
        const revUnnecessary = agentRevision?.unnecessaryFiles ?? judgement.unnecessaryFiles;

        const mismatchSeverity: "minor" | "major" = agentRevision != null
          ? "major"
          : judgement.severity === "minor" ? "minor" : "major";
        const requiresInterrupt = mismatchSeverity === "major";

        if (requiresInterrupt) {
          const proposal: RevisionProposal = {
            runId,
            type: revType,
            reason: revReason,
            originalPlan: preGeneratedPlan.objective,
            revisedPlanSummary: revSummary,
            ...(revMissing ? { missingFiles: revMissing } : {}),
            ...(revUnnecessary ? { unnecessaryFiles: revUnnecessary } : {}),
          };

          const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0
            ? input.timeoutMs
            : (input.isHeadless ? 30_000 : 10 * 60 * 1000);

          const { decision, revisionId: approvalRevisionId } = await requestRevisionApproval({
            proposal,
            emit: (evt) => input.emit({ stage: "scope_revision", progress: { ...evt, ts: Date.now() } }),
            abortSignal: input.abortSignal,
            autoApprove: input.autoApprove,
            timeoutMs,
          });

          revisionDecision = decision;

          if (decision === "timeout") {
            earlyExit = { terminationReason: "revision_approval_timeout", proposal, revisionId: approvalRevisionId };
            log("[scope-revision-timeout]", JSON.stringify({
              runId,
              revisionId: approvalRevisionId,
              timeoutMs,
              ts: new Date().toISOString(),
            }));
          } else if (decision === "approve") {
            log("[zone-scope-revision-approved]", JSON.stringify({ runId, type: revType, ts: new Date().toISOString() }));
            input.emit({
              stage: "scope_revision",
              progress: {
                runId,
                ts: Date.now(),
                type: "scope_revision_resolved",
                title: "Scope revision approved",
                revisionDecision: "approve",
                status: "success",
              },
            });
          } else {
            log("[zone-scope-revision-rejected]", JSON.stringify({ runId, type: revType, ts: new Date().toISOString() }));
            input.emit({
              stage: "scope_revision",
              progress: {
                runId,
                ts: Date.now(),
                type: "scope_revision_resolved",
                title: "Scope revision rejected — proceeding with original plan",
                revisionDecision: "reject",
                status: "active",
              },
            });
          }
        } else {
          log("[zone-scope-auto-apply]", JSON.stringify({ runId, type: revType, severity: "minor", ts: new Date().toISOString() }));
          input.emit({
            stage: "scope_revision",
            progress: {
              runId,
              ts: Date.now(),
              type: "scope_revision_resolved",
              title: "Scope revision auto-applied (minor)",
              revisionDecision: "auto_apply",
              status: "success",
            },
          });
        }
      }

      if (!earlyExit) {
        input.emit({
          stage: "scope_revision",
          progress: {
            runId,
            ts: Date.now(),
            type: "scope_audit_completed",
            title: "Scope audit complete",
            status: "success",
          },
        });
      }
    }
  } catch (auditErr) {
    console.warn("[zone-scope-audit] audit gate failed:", auditErr instanceof Error ? auditErr.message : String(auditErr));
  }

  return { auditFindings, revisionDecision, earlyExit };
}
