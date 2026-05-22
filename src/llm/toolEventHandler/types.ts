import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import type { AgentLoopResult } from "../agentLoop.js";
import type { FailureRecord } from "../agentLoop.js";
import type { TokenBudgetMeter } from "../tokenBudget/TokenBudgetMeter.js";
import type { DetectorState } from "../loopDetector.js";
import type { ToolResult } from "../../tools/toolExecutor.js";

export interface ToolCallLogEntry {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
  success?: boolean;
}

export interface ToolEventContext {
  // Collections — mutated in place (by reference)
  toolCallLog: ToolCallLogEntry[];
  filesModified: Set<string>;
  filesReadThisRun: Set<string>;
  filesReadCountThisRun: Map<string, number>;
  failureHistory: Map<string, FailureRecord[]>;
  responseInput: ChatCompletionMessageParam[];
  failedFilesThisIter: Set<string>;

  // Primitive flags — handleToolResult assigns; caller reads back after call
  failureDetected: boolean;
  failedToolName: string;
  failedToolOutput: string;
  failedToolError: string;
  failedToolFilePath: string | null;
  rollbackCount: number;
  lastLoopResult: { status: "ok" | "warn" | "terminate"; count: number } | null;
}

export type ToolEventResult =
  | { kind: "continue" }
  | { kind: "early_exit"; exit: AgentLoopResult };

/** Exported for Gap 11 (CoachingController). Subset of ToolEventContext failure flags. */
export interface FailureSignal {
  failureDetected: boolean;
  failedToolName: string;
  failedToolOutput: string;
  failedToolError: string;
  failedToolFilePath: string | null;
  failedFilesThisIter: Set<string>;
}

export interface HandleToolResultDeps {
  budget: TokenBudgetMeter;
  iter: number;
  runId: string | null | undefined;
  effectiveTokenBudgetCap: number;
  tokenBudgetHardThreshold: number;
  detectorState: DetectorState;
  throwIfAborted: (site: string) => void;
  onStructuredEvent: ((e: unknown) => void) | undefined;
  onToolResult: ((name: string, result: ToolResult) => void) | undefined;
  synthesizeTokenBudgetExit: (iter: number, messages: ChatCompletionMessageParam[]) => Promise<AgentLoopResult>;
  synthesizeLoopDetectedExit: (iter: number, toolName: string, count: number) => AgentLoopResult;
  classifyFailure: (toolName: string, output: string, error: string | undefined) => string;
  extractSemanticSmellName: (output: string) => string;
  extractErrorLine: (output: string) => number | null;
  hashPatchBlocks: (args: Record<string, unknown>) => string;
  hashToolCall: (name: string, args: Record<string, unknown>) => string;
  recordAndDetect: (state: DetectorState, hash: string) => { status: "ok" | "warn" | "terminate"; count: number };
}
