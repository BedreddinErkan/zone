const perRunSizeLog = new Map<string, Array<{ tool: string; bytes: number }>>();

export function recordToolResultSize(runId: string, tool: string, bytes: number): void {
  const arr = perRunSizeLog.get(runId) ?? [];
  arr.push({ tool, bytes });
  perRunSizeLog.set(runId, arr);
}

export function getAndClearToolResultSummary(runId: string): {
  totalResults: number;
  totalBytes: number;
  perTool: Record<string, { count: number; bytes: number }>;
} | null {
  const arr = perRunSizeLog.get(runId);
  perRunSizeLog.delete(runId);
  if (!arr || arr.length === 0) return null;
  const perTool: Record<string, { count: number; bytes: number }> = {};
  let totalBytes = 0;
  for (const { tool, bytes } of arr) {
    if (!perTool[tool]) perTool[tool] = { count: 0, bytes: 0 };
    perTool[tool].count++;
    perTool[tool].bytes += bytes;
    totalBytes += bytes;
  }
  return { totalResults: arr.length, totalBytes, perTool };
}

export function clearToolResultSizeTrackerForTest(): void {
  perRunSizeLog.clear();
}
