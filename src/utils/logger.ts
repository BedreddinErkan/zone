import type { FeatureAgentResult, ValidationIssue } from "../types/agent.js";

const VERBOSE = process.env.ZONE_VERBOSE_LOGS === "1";

export const log = (...args: unknown[]): void => {
  console.log(...args);
};

export const debugLog = (...args: unknown[]): void => {
  if (VERBOSE) console.log(...args);
};

export const errorLog = (...args: unknown[]): void => {
  console.error(...args);
};

export type ZoneLogLevel = "debug" | "info" | "quiet";

export const LOG_LEVEL: ZoneLogLevel =
  ((): ZoneLogLevel => {
    const raw = String(process.env.ZONE_LOG_LEVEL || "debug")
      .trim()
      .toLowerCase();
    if (raw === "info" || raw === "quiet") return raw;
    return "debug";
  })();

export const logger = {
  debug: (...args: unknown[]): void => {
    if (LOG_LEVEL === "debug") console.log(...args);
  },
  info: (...args: unknown[]): void => {
    if (LOG_LEVEL === "debug" || LOG_LEVEL === "info") console.log(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};

function timestamp(): string {
  return new Date().toISOString();
}

export function logInfo(message: string): void {
  console.log(`[INFO ${timestamp()}] ${message}`);
}

export function logSuccess(message: string): void {
  console.log(`[SUCCESS ${timestamp()}] ${message}`);
}

export function logWarn(message: string): void {
  console.warn(`[WARN ${timestamp()}] ${message}`);
}

export function logError(message: string): void {
  console.error(`[ERROR ${timestamp()}] ${message}`);
}

function printSection(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function printKeyValue(label: string, value: string | number): void {
  console.log(`${label.padEnd(18)}: ${value}`);
}

function truncate(value: string, maxLength = 180): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function uniqueStrings(items: string[] = []): string[] {
  return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
}

function printIssueList(
  issues: ValidationIssue[] = [],
  options?: {
    limit?: number;
    emptyMessage?: string;
  }
): void {
  const limit = options?.limit ?? 5;
  const emptyMessage = options?.emptyMessage ?? "No issues.";

  if (!issues.length) {
    console.log(emptyMessage);
    return;
  }

  const visible = issues.slice(0, limit);

  for (const issue of visible) {
    const fileText = issue.file ? ` [${issue.file}]` : "";
    const detailsRaw = Array.isArray(issue.details)
      ? issue.details.join("; ")
      : issue.details;
    const detailsText = detailsRaw ? ` | ${truncate(detailsRaw, 120)}` : "";

    console.log(
      `- [${issue.severity.toUpperCase()}] ${issue.code}: ${truncate(issue.message, 180)}${fileText}${detailsText}`
    );
  }

  if (issues.length > visible.length) {
    console.log(`- ...and ${issues.length - visible.length} more`);
  }
}

function printStringList(
  items: string[] = [],
  options?: {
    limit?: number;
    emptyMessage?: string;
    truncateAt?: number;
  }
): void {
  const limit = options?.limit ?? 6;
  const emptyMessage = options?.emptyMessage ?? "- none";
  const truncateAt = options?.truncateAt ?? 180;

  const uniqueItems = uniqueStrings(items);

  if (!uniqueItems.length) {
    console.log(emptyMessage);
    return;
  }

  const visible = uniqueItems.slice(0, limit);

  for (const item of visible) {
    console.log(`- ${truncate(item, truncateAt)}`);
  }

  if (uniqueItems.length > visible.length) {
    console.log(`- ...and ${uniqueItems.length - visible.length} more`);
  }
}

function printIssueSummary(label: string, issues: ValidationIssue[] = []): void {
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter(
    (issue) => issue.severity === "warning"
  ).length;

  printKeyValue(label, `${errorCount} error(s), ${warningCount} warning(s)`);
}

export function printFeatureAgentReport(result: FeatureAgentResult): void {
  printSection("INTENT ANALYSIS");
  printKeyValue("Task", truncate(result.task, 120));
  printKeyValue("Operation", result.intent?.action ?? "unknown");
  printKeyValue("Resource Kind", result.intent?.resourceKind ?? "unknown");
  printKeyValue("Scope", result.intent?.scope ?? "unknown");
  printKeyValue("Parent", result.intent?.parentResource ?? "unknown");
  printKeyValue("Nested", result.intent?.nestedResource ?? "n/a");
  printKeyValue("Intent Score", result.confidence?.intentClarity ?? "n/a");

  if (result.intent?.warnings?.length) {
    console.log("\nIntent warnings:");
    printStringList(result.intent.warnings, {
      limit: 4,
      truncateAt: 160
    });
  }

  printSection("SCHEMA & STORAGE");
  printKeyValue(
    "Schema Score",
    result.confidence?.schemaCertainty ?? "n/a"
  );
  printKeyValue(
    "Storage Score",
    result.confidence?.storageCertainty ?? "n/a"
  );
  printKeyValue(
    "Patch Health",
    result.confidence?.patchValidationHealth ?? "n/a"
  );
  printKeyValue(
    "Primary Storage",
    result.storageInsight?.primaryStorage ?? "unknown"
  );
  printKeyValue(
    "Detected Clients",
    result.storageInsight?.detectedClients.join(", ") || "n/a"
  );

  if (result.schemaAwareSummary?.summary) {
    printKeyValue(
      "Schema Summary",
      truncate(result.schemaAwareSummary.summary, 180)
    );
  }

  if (result.schemaAwareSummary?.entities?.length) {
    printKeyValue(
      "Entities",
      truncate(result.schemaAwareSummary.entities.join(", "), 120)
    );
  }

  if (result.storageInsight?.reasoning?.length) {
    console.log("\nStorage reasoning:");
    printStringList(result.storageInsight.reasoning, {
      limit: 4,
      truncateAt: 160
    });
  }

  printSection("VALIDATION SUMMARY");
  printIssueSummary("Patch Validation", result.patchValidationIssues);
  printIssueSummary("Schema Validation", result.schemaPatchWarnings);

  if (result.patchValidationIssues?.length) {
    console.log("\nPatch validation issues:");
    printIssueList(result.patchValidationIssues, {
      limit: 4,
      emptyMessage: "No patch validation issues."
    });
  }

  if (result.schemaPatchWarnings?.length) {
    console.log("\nSchema validation issues:");
    printIssueList(result.schemaPatchWarnings, {
      limit: 4,
      emptyMessage: "No schema validation issues."
    });
  }

  printSection("FINAL DECISION");
  printKeyValue("Mode", result.decision?.mode ?? "unknown");
  printKeyValue(
    "Confidence",
    `${result.decision?.confidenceScore ?? result.confidence?.finalScore ?? 0}/100`
  );
  printKeyValue("Reason", truncate(result.decision?.reason ?? "n/a", 180));

  if (result.architectureWarnings?.length) {
    console.log("\nArchitecture warnings:");
    printStringList(result.architectureWarnings, {
      limit: 4,
      truncateAt: 160
    });
  }

  if (result.patchRiskWarnings?.length) {
    console.log("\nPatch risk warnings:");
    printStringList(result.patchRiskWarnings, {
      limit: 4,
      truncateAt: 160
    });
  }

  if (result.executionNotes?.notes?.length) {
    console.log("\nExecution notes:");
    printStringList(result.executionNotes.notes, {
      limit: 4,
      truncateAt: 160
    });
  }

  if (result.executionNotes?.assumptions?.length) {
    console.log("\nAssumptions:");
    printStringList(result.executionNotes.assumptions, {
      limit: 4,
      truncateAt: 160
    });
  }

  if (result.executionNotes?.followUps?.length) {
    console.log("\nRecommended follow-ups:");
    printStringList(result.executionNotes.followUps, {
      limit: 5,
      truncateAt: 160
    });
  }

  if (result.applyResults?.length) {
    printSection("APPLY RESULTS");
    for (const item of result.applyResults) {
      console.log(
        `- ${item.path} -> ${item.action}${item.outputPath ? ` (${item.outputPath})` : ""}`
      );
      console.log(`  reason: ${truncate(item.reason, 160)}`);
    }
  }
}
