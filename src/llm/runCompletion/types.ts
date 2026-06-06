import type { ProjectFramework } from "../../repo/detectFramework.js";
import type { SubagentTokenUsage } from "../subagents.js";
import type { TaskArchetype } from "../taskClassifier.js";
import type { VerificationReason } from "../verification/verificationReason.js";

export type ToolCallLogEntry = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  success?: boolean;
};

export interface FinalizeRunInput {
  trigger: "natural_completion" | "max_iterations" | "max_iterations_readonly";
  /** Raw text from LLM; may contain embedded [ZONE_VERIFICATION:...] tag. */
  finalText?: string;
  /** Pre-computed for max_iterations when LLM provided a tag. */
  inferredFrom?: "tag" | "heuristic";

  toolCallLog: ToolCallLogEntry[];
  filesModified: Set<string>;
  stagingFiles: Map<string, string>;
  /** For natural_completion readOnly sub-path. */
  isReadOnlyMode?: boolean;
  ownsStagingFiles: boolean;
  withStagingTempFlush: <T>(staging: Map<string, string>, body: () => Promise<T>) => Promise<T>;
  verifyMode: "warn" | "rollback";
  framework?: ProjectFramework;
  repoPath: string;

  /** iter+1 for natural_completion; completedIterCount for max_iterations paths. */
  iterCount: number;
  costUsd: number;
  tokenUsage: SubagentTokenUsage;

  promotedFromArchetype?: TaskArchetype | null;
  promotionTrigger?: "iter_cap" | "rollback_x2" | "coaching_exhausted" | "forced_tier_blocking" | null;
  promotedAtIter?: number | null;

  emit: {
    runBreakdownSummary: () => void;
    cacheSummary: () => void;
    selfValidationSummary: () => void;
    webSearchSummary: () => void;
  };
  onProgress?: (msg: string) => void;
  runId?: string;
}

export interface VerdictInput {
  /** Raw text from LLM; parseVerificationTag applied internally. */
  finalText: string;
  trigger: "natural_completion" | "max_iterations";
  toolCallLog: ToolCallLogEntry[];
  filesModified: string[];
  framework?: { hasTests: boolean; testFilesDetected?: boolean };
  patchApplied: boolean;
  onProgress?: (msg: string) => void;
}

export interface VerdictResult {
  reason: VerificationReason;
  patchValidatedByAgent: boolean;
  inferredFrom: "tag" | "heuristic";
  /** finalText with the [ZONE_VERIFICATION:...] tag removed. */
  strippedText: string;
}
