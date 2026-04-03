import type { DecideExecutionModeResult } from "../decision/decideExecutionMode.js";
import type { ZoneCode, ZoneSeverity, ZoneStageResultV2, ZoneStageStatus } from "../output/zoneStageTypes.js";
import { buildStageResultV2 } from "./buildStageResultV2.js";

function resolveStatus(mode: DecideExecutionModeResult["mode"]): ZoneStageStatus {
  switch (mode) {
    case "blocked":
      return "blocked";
    case "preview_only":
      return "success";
    case "safe_to_apply":
      return "success";
  }
}

function resolveSeverity(mode: DecideExecutionModeResult["mode"]): ZoneSeverity {
  switch (mode) {
    case "blocked":
      return "fatal";
    case "preview_only":
      return "warning";
    case "safe_to_apply":
      return "ok";
  }
}

function resolveCode(
  mode: DecideExecutionModeResult["mode"],
  reasons: DecideExecutionModeResult["reasons"]
): ZoneCode {
  switch (mode) {
    case "blocked":
      return reasons.some((r) => r.code === "SCHEMA_VALIDATION_ERROR")
        ? "ZONE_BLOCKED_SCHEMA_ERROR"
        : "ZONE_BLOCKED_HIGH_RISK";
    case "preview_only":
      return "ZONE_PREVIEW_ONLY";
    case "safe_to_apply":
      return "ZONE_OK";
  }
}

function resolveSummary(mode: DecideExecutionModeResult["mode"]): string {
  switch (mode) {
    case "blocked":
      return "Decision blocked: automatic apply is not permitted.";
    case "preview_only":
      return "Decision preview only: manual review is required before apply.";
    case "safe_to_apply":
      return "Decision safe to apply: no blocking risks detected.";
  }
}

export function buildDecisionStageResult(
  result: DecideExecutionModeResult
): ZoneStageResultV2 {
  const { mode, reasons } = result;

  const details =
    reasons.length > 0
      ? reasons.map((r) => r.message).join(" | ")
      : undefined;

  return buildStageResultV2({
    stage: "decision",
    status: resolveStatus(mode),
    severity: resolveSeverity(mode),
    code: resolveCode(mode, reasons),
    summary: resolveSummary(mode),
    details,
  });
}
