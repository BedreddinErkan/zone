export interface GroundTask {
  id: string;
  task: string;
  correctFile: string;
  [key: string]: unknown;
}

export declare function loadGroundTasks(
  snapshotPath: string,
  only: string[] | "all" | null
): GroundTask[];

export interface TaskPrediction {
  discoveryCount?: number;
  falseNegativeResolves?: boolean | null;
}

export interface PredictionsRaw {
  perTask: Record<string, TaskPrediction>;
  anyRefusal?: boolean;
  rationale?: string;
}

export interface Predictions extends PredictionsRaw {
  validationWarnings: string[];
}

export declare function loadPredictions(path: string): Predictions;

export declare function validatePredictions(raw: unknown): string[];

export interface RawToolCallLogEntry {
  tool?: string;
  args?: unknown;
  success?: boolean;
  result?: unknown;
}

export interface LoopResult {
  iterCount?: number;
  terminationReason?: string | null;
  success?: boolean;
  costUsd?: number;
  tokenUsage?: unknown;
  toolCallLog?: RawToolCallLogEntry[];
  summary?: unknown;
}

export interface CaptureRecordInput {
  arm: string;
  task: GroundTask;
  model: string;
  provider: string;
  err?: string | null;
  wallMs?: number;
  aborted?: boolean;
  gitClean?: boolean;
  gitBefore?: string;
  gitAfter?: string;
  loop?: LoopResult | null;
  iterCap: number;
  calls?: unknown[];
}

// Output-only: what buildCaptureRecord's own toolCallLog mapping always produces —
// resultLen/resultHead are unconditionally computed, never omitted.
export interface CaptureToolCallLogEntry {
  tool?: string;
  args?: { command?: string; [key: string]: unknown };
  success?: boolean;
  resultLen: number;
  resultHead: string;
}

// Input-only, for scoreTaskDiscovery: looser than the output type above, because the
// test builds partial toolCallLog mocks directly (sometimes without resultHead at all)
// rather than always routing them through buildCaptureRecord. scoreTaskDiscovery itself
// only ever reads tool / args?.command / resultHead.
export interface ScoredToolCallLogEntry {
  tool?: string;
  args?: { command?: string; [key: string]: unknown };
  success?: boolean;
  resultHead?: string;
}

export interface CaptureRecord {
  arm: string;
  id: string;
  task: string;
  correctFile: string;
  model: string;
  provider: string;
  error: string | null;
  wallMs?: number;
  aborted: boolean;
  gitClean?: boolean;
  gitBefore?: string;
  gitAfter?: string;
  iterCount: number | null;
  iterCap: number;
  terminationReason: string | null;
  success: boolean | null;
  costUsd: number | null;
  tokenUsage: unknown;
  onToolCallSeq: unknown[];
  toolCallLog: CaptureToolCallLogEntry[];
  summary: string;
}

export declare function buildCaptureRecord(input: CaptureRecordInput): CaptureRecord;

export interface RegisteredToolLike {
  name: string;
}

export declare function suppressNonOffered(
  offeredNames: string[],
  registry: {
    listRegisteredTools: () => readonly RegisteredToolLike[];
    registerTool: (tool: any) => void;
  }
): RegisteredToolLike[];

export declare function restoreSuppressed(
  disabled: RegisteredToolLike[],
  registry: { registerTool: (tool: any) => void }
): void;

export declare function buildCreditProbeParams(
  model: string,
  provider: string
): {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
};

export declare const DISCOVERY_BINARIES: readonly string[];

export declare function isDiscoveryCommand(command: string | undefined | null): boolean;

export declare function isRefusal(resultHead: string | undefined | null): boolean;

export interface ScoreTaskDiscoveryResult {
  discoveryCount: number;
  discoveryCalls: string[];
  allShellCalls: string[];
  refused: boolean;
  refusedCalls: string[];
  refusedDiscoveryShapedCalls: string[];
}

export declare function scoreTaskDiscovery(
  toolCallLog: ScoredToolCallLogEntry[] | undefined | null
): ScoreTaskDiscoveryResult;

// Deliberately narrower than ScoreTaskDiscoveryResult — compareDiscovery's own body
// only ever reads taskId/discoveryCount/refused/summary from a scored result, and the
// test constructs several of these by hand without the other scoreTaskDiscovery fields.
// A wider object (e.g. main()'s real ...scoreTaskDiscovery(...) spread) still satisfies
// this structurally, so the real call site is unaffected.
export interface ScoredTaskResult {
  taskId: string;
  summary?: unknown;
  discoveryCount: number;
  refused: boolean;
}

export interface CompareDiscoveryResult {
  perTask: Record<
    string,
    {
      predictedDiscoveryCount: number | null;
      actualDiscoveryCount: number;
      discoveryMatch: boolean | null;
      predictedFalseNegativeResolves: boolean | null;
      actualSummary: unknown;
      requiresHumanJudgment: boolean;
    }
  >;
  anyRefusal: {
    predicted: boolean | null;
    actual: boolean;
    match: boolean | null;
  };
}

export declare function compareDiscovery(
  predictions: PredictionsRaw,
  scoredResults: ScoredTaskResult[]
): CompareDiscoveryResult;

export declare function probeCredit(
  client: { createChatCompletion: (params: unknown) => Promise<unknown> },
  model: string,
  provider: string
): Promise<{ ok: boolean; message?: string }>;

export interface RunPromptAuditInput {
  capturesDir: string;
  ARM: string;
  only: string[] | null;
  runStamp: number;
  memoryRepoPath?: string;
  renderedRepoPath?: string;
}

export interface RunPromptAuditResult {
  sysNoNotice: string;
  sysWithNotice: string;
  noNoticePath: string;
  withNoticePath: string;
  offered: string[];
  notice: string;
  capabilityFilter: unknown;
  offeredToolNamesUsed: string[];
}

export declare function runPromptAudit(
  input: RunPromptAuditInput
): Promise<RunPromptAuditResult>;
