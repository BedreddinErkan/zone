import type { AuditSnapshotDiff } from "./snapshotDiff.js";

export function renderAuditDiff(diff: AuditSnapshotDiff): string {
  const lines: string[] = ["=== AUDIT DIFF ===", ""];

  if (diff.modeChanged) {
    lines.push(`Mode: ${diff.previous.mode} -> ${diff.current.mode}`);
  } else {
    lines.push(`Mode: unchanged (${diff.current.mode})`);
  }

  if (diff.confidenceChanged) {
    lines.push(
      `Confidence: ${diff.previous.confidenceScore} -> ${diff.current.confidenceScore}`
    );
  } else {
    lines.push(`Confidence: unchanged (${diff.current.confidenceScore})`);
  }

  if (diff.riskChanged) {
    lines.push(`Risk: ${diff.previous.riskScore} -> ${diff.current.riskScore}`);
  } else {
    lines.push(`Risk: unchanged (${diff.current.riskScore})`);
  }

  if (diff.parityChanged) {
    lines.push(
      `Parity: ${diff.previous.parityValid} -> ${diff.current.parityValid}`
    );
  } else {
    lines.push(`Parity: unchanged (${diff.current.parityValid})`);
  }

  lines.push("");

  if (
    diff.reasonCodesAdded.length === 0 &&
    diff.reasonCodesRemoved.length === 0
  ) {
    lines.push("Reason Codes: no changes");
  } else {
    lines.push("Reason Codes:");
    for (const code of diff.reasonCodesAdded) {
      lines.push(`+ ${code}`);
    }
    for (const code of diff.reasonCodesRemoved) {
      lines.push(`- ${code}`);
    }
  }

  lines.push("");

  if (
    diff.contradictionFlagsAdded.length === 0 &&
    diff.contradictionFlagsRemoved.length === 0
  ) {
    lines.push("Contradiction Flags: no changes");
  } else {
    lines.push("Contradiction Flags:");
    for (const flag of diff.contradictionFlagsAdded) {
      lines.push(`+ ${flag}`);
    }
    for (const flag of diff.contradictionFlagsRemoved) {
      lines.push(`- ${flag}`);
    }
  }

  lines.push("");
  lines.push(
    diff.traceReasonMappingChanged
      ? "Trace Reason Mapping: changed"
      : "Trace Reason Mapping: unchanged"
  );

  return lines.join("\n");
}