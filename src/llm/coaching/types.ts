import type {
  IterationBudgetState,
  SelfCorrectTrigger,
  FailureRecord,
} from "../agentLoop.js";
import type { FailureSignal, ToolCallLogEntry } from "../toolEventHandler/types.js";
import type { VerifyDiagnosticInput, VerifyDiagnostic } from "../../core/buildVerifyDiagnostic.js";
import type { ScopeExpansionResult } from "../../tools/scopeGuard.js";
import type { CoachingRuleData } from "../loopTelemetry.js";
import type { ExecutionPlan } from "../executionPlan.js";
import type { ProjectFramework } from "../../repo/detectFramework.js";

export interface FailureContext {
  signal: FailureSignal;
  iter: number;
  failureHistory: Map<string, FailureRecord[]>;
  toolCallLog: ToolCallLogEntry[];
  filesModified: Set<string>;
  filesReadCountThisRun?: Map<string, number>;
  repoFilePaths?: readonly string[];
  framework?: ProjectFramework | null;
  executionPlan?: ExecutionPlan | null;
  repoPath?: string;
  currentBudget: IterationBudgetState;
  maxAttempts: number;
  /** Active model name (e.g. "claude-sonnet-4-6", "gpt-4o"). Used to gate
   *  provider-specific coaching appendices (CE.4.1.g). Absent in tests
   *  that don't thread a model — absence = include (backward compat). */
  modelId?: string;
}

export type CoachingDecision =
  | {
      kind: "coach";
      coachingAppend: string;
      newIterationBudget?: IterationBudgetState;
      scopeExpanded?: { addedFile: string; reason: string };
    }
  | { kind: "exhausted" }
  | { kind: "noop" };

export interface CoachingControllerOpts {
  escalationEnabled: boolean;
  baseMaxIterations: number;
  escalatedFiles: Set<string>;
  runId: string | null | undefined;
  onProgress?: (msg: string) => void;
}

export interface CoachingDeps {
  detectRepeatedFailure: (
    history: Map<string, FailureRecord[]>,
    filePath: string | null
  ) => { filePath: string; reason: string } | null;
  maybeGrantEscalationBonus: (
    state: IterationBudgetState,
    escalatedFileCount: number,
    currentIter: number,
    onProgress: ((msg: string) => void) | undefined,
    baseMaxIterations?: number
  ) => IterationBudgetState;
  buildCoachingPrompt: (
    trigger: SelfCorrectTrigger,
    errorPreview: string,
    toolCallLog: ToolCallLogEntry[],
    opts?: {
      attemptCount?: number;
      filePath?: string;
      generatedPathDetected?: boolean;
      parsedFailingFile?: string | null;
      /** Active model — used to gate provider-specific appendices (CE.4.1.g).
       *  Absent = include (backward compat for tests and legacy callers). */
      model?: string;
    }
  ) => string;
  buildVerifyDiagnostic: (input: VerifyDiagnosticInput) => VerifyDiagnostic;
  maybeExpandScopeForVerifyDiagnostic: (
    executionPlan: ExecutionPlan | null | undefined,
    diagnostic: VerifyDiagnostic,
    repoPath?: string
  ) => ScopeExpansionResult;
  applyPatchRetryReason: (trigger: SelfCorrectTrigger | string) => string;
  classifyFailure: (toolName: string, output: string, error?: string) => string;
  emitCoachingRule: (data: CoachingRuleData) => void;
}
