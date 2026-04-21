export type VerificationResult = {
  score: number;
  issues: string[];
  warnings: string[];
};

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

function isSmallTask(task: string): boolean {
  return /\b(small|tiny|minor|simple|minimal|quick|spacing|copy|label|text|color|rename|typo|badge)\b/i.test(
    task
  );
}

function repoHasTestFiles(repoFiles: string[]): boolean {
  return repoFiles.some((filePath) =>
    /(^|\/)(test|tests|__tests__)\//i.test(normalizePath(filePath)) ||
    /\.(test|spec)\./i.test(filePath)
  );
}

function isTestFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return (
    /(^|\/)(test|tests|__tests__)\//i.test(normalized) ||
    /\.(test|spec)\./i.test(filePath)
  );
}

function looksRelatedToTask(filePath: string, task: string): boolean {
  const normalizedTask = task.toLowerCase();
  const baseName = normalizePath(filePath)
    .split("/")
    .pop()
    ?.replace(/\.[^.]+$/, "");
  if (!baseName) return false;
  return baseName
    .split(/[^a-z0-9]+/i)
    .filter((token) => token.length >= 3)
    .some((token) => normalizedTask.includes(token.toLowerCase()));
}

function hasSyntaxRedFlags(patchContent: string): boolean {
  return (
    /\b(?:const|let|var)\s+\w+\s*=\s*undefined\b/.test(patchContent) ||
    /=\s*undefined\s*;/.test(patchContent) ||
    /\bimport\s+from\b/.test(patchContent) ||
    /\bexport\s+from\b/.test(patchContent) ||
    /\bexport\s+default\s*;/.test(patchContent)
  );
}

export function verifyPatch(input: {
  changedFiles: string[];
  patchContent: string;
  task: string;
  repoFiles: string[];
}): VerificationResult {
  let score = 100;
  const issues: string[] = [];
  const warnings: string[] = [];
  const normalizedRepoFiles = new Set(input.repoFiles.map(normalizePath));
  const changedFiles = [
    ...new Set(input.changedFiles.map((filePath) => filePath.trim()).filter(Boolean)),
  ];

  if (isSmallTask(input.task) && input.patchContent.length > 4000) {
    score -= 20;
    warnings.push("Patch size larger than expected for task");
  }

  if (repoHasTestFiles(input.repoFiles) && !changedFiles.some(isTestFile)) {
    score -= 10;
    warnings.push("No test updates detected");
  }

  const unrelatedNewFiles = changedFiles.filter(
    (filePath) =>
      !normalizedRepoFiles.has(normalizePath(filePath)) &&
      !looksRelatedToTask(filePath, input.task)
  );
  if (unrelatedNewFiles.length > 0) {
    score -= 15;
  }

  if (hasSyntaxRedFlags(input.patchContent)) {
    score -= 10;
  }

  const clampedScore = clampScore(score);
  if (clampedScore < 70) {
    issues.push("Patch may not be reliable without further validation");
  }

  return {
    score: clampedScore,
    issues,
    warnings,
  };
}
