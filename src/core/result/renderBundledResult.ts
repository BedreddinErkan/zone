import type { ZoneBundledResult, ZoneStageResultV2 } from "../output/zoneStageTypes.js";

function renderStage(stage: ZoneStageResultV2): string {
  const lines: string[] = [
    `--- Stage: ${stage.stage} ---`,
    `Status: ${stage.status}`,
    `Severity: ${stage.severity}`,
    `Code: ${stage.code}`,
    `Summary: ${stage.summary}`,
  ];

  if (stage.details !== undefined) {
    lines.push(`Details: ${stage.details}`);
  }

  return lines.join("\n");
}

export function renderBundledResult(result: ZoneBundledResult): string {
  const sections: string[] = [
    "=== ZONE BUNDLED RESULT ===",
    `Engine: ${result.engine}`,
    `Version: ${result.version}`,
    `Overall Status: ${result.overallStatus}`,
    `Overall Severity: ${result.overallSeverity}`,
  ];

const stageOrder = [
    "decision",
    "generated_patch_preview",
    "generated_patch_conversion",
    "apply",
  ] as const;

  for (const key of stageOrder) {
    const stage = result.stages[key];
    if (stage !== undefined) {
      sections.push(renderStage(stage));
    }
  }

  if (result.timestamps !== undefined) {
    sections.push(
      [
        "--- Timestamps ---",
        `Started: ${result.timestamps.startedAt}`,
        `Completed: ${result.timestamps.completedAt}`,
        `Duration: ${result.timestamps.durationMs}ms`,
      ].join("\n")
    );
  }

  return sections.join("\n");
}
