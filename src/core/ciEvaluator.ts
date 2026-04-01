import type {
  CiEvaluationResult,
  FeatureAgentResult,
  ValidationIssue
} from "../types/agent.js";

function formatIssue(issue: ValidationIssue): string {
  const filePart = issue.file ? ` [${issue.file}]` : "";
  return `[${issue.severity}] ${issue.message}${filePart}`;
}

function collectTopAnnotations(result: FeatureAgentResult): string[] {
  const annotations: string[] = [];

  for (const issue of result.patchValidationIssues.slice(0, 3)) {
    annotations.push(formatIssue(issue));
  }

  for (const issue of result.schemaPatchWarnings.slice(0, 3)) {
    annotations.push(formatIssue(issue));
  }

  for (const warning of result.patchRiskWarnings.slice(0, 2)) {
    annotations.push(warning);
  }

  for (const warning of result.architectureWarnings.slice(0, 2)) {
    annotations.push(warning);
  }

  const missingFiles = result.validatedSuggestedFiles
    .filter((file) => file.status === "missing")
    .slice(0, 2)
    .map((file) => `Missing suggested file: ${file.originalPath}`);

  annotations.push(...missingFiles);

  return [...new Set(annotations)];
}

function buildSummary(result: FeatureAgentResult): string {
  return [
    `decision=${result.decision.mode}`,
    `confidence=${result.confidence.finalScore}`,
    `patches=${result.patchPlan.patches.length}`,
    `warnings=${collectTopAnnotations(result).length}`,
    `relevant=${result.relevantFiles.length}`,
    `suggested=${result.validatedSuggestedFiles.length}`
  ].join(" | ");
}

export function evaluateFeatureAgentForCi(
  result: FeatureAgentResult
): CiEvaluationResult {
  const annotations = collectTopAnnotations(result);
  const summary = buildSummary(result);

  if (result.decision.mode === "blocked") {
    return {
      outcome: "fail",
      exitCode: 1,
      shouldFail: true,
      title: "Feature agent blocked",
      summary,
      annotations
    };
  }

  if (result.decision.mode === "preview_only") {
    return {
      outcome: "warn",
      exitCode: 0,
      shouldFail: false,
      title: "Feature agent requires review",
      summary,
      annotations
    };
  }

  return {
    outcome: "pass",
    exitCode: 0,
    shouldFail: false,
    title: "Feature agent approved",
    summary,
    annotations
  };
}

export function printCiAnnotations(evaluation: CiEvaluationResult): void {
  const prefix =
    evaluation.outcome === "fail"
      ? "::error::"
      : evaluation.outcome === "warn"
        ? "::warning::"
        : "::notice::";

  console.log(`${prefix}${evaluation.title} | ${evaluation.summary}`);

  for (const annotation of evaluation.annotations) {
    console.log(`${prefix}${annotation}`);
  }
}