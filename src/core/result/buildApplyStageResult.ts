import type { ApplyFlowResult } from "../../patch/applyFlowTypes.js";
import type { ZoneCode, ZoneSeverity, ZoneStageResultV2, ZoneStageStatus } from "../output/zoneStageTypes.js";
import { buildStageResultV2 } from "./buildStageResultV2.js";

function resolveStatus(status: ApplyFlowResult["status"]): ZoneStageStatus {
  switch (status) {
    case "applied":
      return "success";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
  }
}

function resolveSeverity(
  status: ApplyFlowResult["status"],
  operationsApplied: number
): ZoneSeverity {
  switch (status) {
    case "applied":
      return "ok";
    case "failed":
      return operationsApplied > 0 ? "error" : "fatal";
    case "skipped":
      return "warning";
  }
}

function resolveCode(
  status: ApplyFlowResult["status"],
  operationsApplied: number
): ZoneCode {
  switch (status) {
    case "applied":
      return "ZONE_APPLY_SUCCESS";
    case "failed":
      return operationsApplied > 0 ? "ZONE_APPLY_PARTIAL" : "ZONE_APPLY_FAILED";
    case "skipped":
      return "ZONE_SKIPPED";
  }
}

function resolveSummary(
  status: ApplyFlowResult["status"],
  operationsApplied: number
): string {
  switch (status) {
    case "applied":
      return "Apply succeeded: all operations applied successfully.";
    case "failed":
      return operationsApplied > 0
        ? "Apply partially failed: some operations were not applied."
        : "Apply failed: no operations were applied.";
    case "skipped":
      return "Apply skipped: no operations were executed.";
  }
}

export function buildApplyStageResult(result: ApplyFlowResult): ZoneStageResultV2 {
  const { status, operationsApplied, filesTouched } = result;

  const details =
    filesTouched.length > 0
      ? `Files touched: ${filesTouched.join(", ")}`
      : undefined;

  return buildStageResultV2({
    stage: "apply",
    status: resolveStatus(status),
    severity: resolveSeverity(status, operationsApplied),
    code: resolveCode(status, operationsApplied),
    summary: resolveSummary(status, operationsApplied),
    details,
  });
}
