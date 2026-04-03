import type { CliOutputFormat } from "../../types/agent.js";
import type { CliRiskItem, CliViewModel } from "./buildCliViewModel.js";
import { buildSavedDecisionExplanation } from "./buildSavedDecisionExplanation.js";
function renderSummary(view: CliViewModel): string {
  const lines: string[] = [];

  lines.push(`Decision: ${view.decisionLabel}`);
  lines.push(view.statusLine);
  lines.push(`Confidence: ${view.confidenceScore}`);
  lines.push(`Issues: ${view.errorCount} error, ${view.warningCount} warning`);
  lines.push(`Recommendation: ${view.recommendation}`);

  const firstRisk = view.topRisks[0];
  if (firstRisk) {
    lines.push(
      `Top Risk: ${firstRisk.severity} (score: ${firstRisk.score}) - ${firstRisk.title}`
    );
  }

  return lines.join("\n");
}

function renderTopRisks(topRisks: CliRiskItem[]): string {
  if (topRisks.length === 0) {
    return "Top Risks: none";
  }

  const lines: string[] = ["Top Risks (prioritized)"];

  for (let i = 0; i < topRisks.length; i++) {
    const risk = topRisks[i];
    if (!risk) continue;
    lines.push(
      `${i + 1}. [${risk.severity}] score=${risk.score} | ${risk.title} (${risk.category})`
    );
    lines.push(`   ${risk.description}`);
  }

  return lines.join("\n");
}

function renderExecution(view: CliViewModel): string | null {
  const exec = view.rawResult.execution;
  if (!exec) return null;

  const lines: string[] = [];
  lines.push("Execution");
  lines.push(`- Trace ID: ${exec.traceId}`);
  lines.push(`- Started: ${exec.startedAt}`);
  lines.push(`- Finished: ${exec.finishedAt}`);
  lines.push(`- Duration: ${exec.durationMs} ms`);

  if (exec.phases.length > 0) {
    lines.push("Phases");
    for (const p of exec.phases) {
      lines.push(`- ${p.name}: ${p.durationMs} ms`);
    }
  }

  return lines.join("\n");
}

function renderDetailed(view: CliViewModel): string {
  const sections: string[] = [];

  sections.push(`Decision: ${view.decisionLabel}`);
  sections.push(`Status: ${view.statusLine}`);
  sections.push(`Confidence: ${view.confidenceScore}`);
  sections.push(`Issue Summary: ${view.errorCount} error, ${view.warningCount} warning`);
  sections.push(`Recommendation\n${view.recommendation}`);
  sections.push(`Explanation\n${buildSavedDecisionExplanation(view.rawResult)}`);

  sections.push(renderTopRisks(view.topRisks));

  if (view.notes.length > 0) {
    sections.push(["Notes", ...view.notes.map((note) => `- ${note}`)].join("\n"));
  }

  const execSection = renderExecution(view);
  if (execSection) {
    sections.push(execSection);
  }

  if (view.groupedIssues.length > 0) {
    const groupedText = view.groupedIssues
      .map((group) => {
        const lines: string[] = [];
        lines.push(`${group.label} (${group.errors} error, ${group.warnings} warning)`);

        for (const issue of group.issues) {
          lines.push(
            `- [${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}`
          );
        }

        return lines.join("\n");
      })
      .join("\n\n");

    sections.push(`Issues\n${groupedText}`);
  }

  return sections.join("\n\n");
}
export function renderCliResult(
  view: CliViewModel,
  format: CliOutputFormat
): string {
  switch (format) {
    case "summary":
      return renderSummary(view);
    case "detailed":
      return renderDetailed(view);
    case "json":
      return JSON.stringify(view.rawResult, null, 2);
    case "bundled":
      return renderSummary(view);
  }
}