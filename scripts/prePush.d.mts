export declare const OVERRIDE_ENV: string;

export interface RefUpdate {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
}

export interface MultiCommitViolation {
  ref: string;
  count: number;
  remoteOid: string;
  localOid: string;
}

export declare function parseRefUpdates(stdinText: string): RefUpdate[];

export declare function classifyRefUpdate(update: RefUpdate): "delete" | "create" | "update";

export declare function findMultiCommitPushes(
  updates: RefUpdate[],
  countCommits: (remoteOid: string, localOid: string) => number | null,
  warn?: (message: string) => void
): MultiCommitViolation[];

export declare function formatRefusal(violations: MultiCommitViolation[]): string;

export declare function runPrePush(input: {
  stdinText: string;
  env?: Record<string, string | undefined>;
  countCommits: (remoteOid: string, localOid: string) => number | null;
  stderr?: (message: string) => void;
}): number;

export declare function gitCountCommits(remoteOid: string, localOid: string): number | null;
