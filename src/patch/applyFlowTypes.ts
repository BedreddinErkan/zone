export type ApplyFlowStatus = "applied" | "failed" | "skipped";
export type ApplyOperationStatus = "applied" | "failed" | "skipped";

export type ApplyOperationResult = {
  index: number;
  type: string;
  filePath: string;
  status: ApplyOperationStatus;
  message: string;
};

export type ApplyFlowResult = {
  status: ApplyFlowStatus;
  operationsAttempted: number;
  operationsApplied: number;
  filesTouched: string[];
  backupCreated: boolean;
  message: string;
  operationResults: ApplyOperationResult[];
};