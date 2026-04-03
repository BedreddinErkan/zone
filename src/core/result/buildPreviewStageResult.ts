import type { GeneratedPatchPlan } from "../../patch-generation/generatedPatchPlanTypes.js";
import type { ZoneCode, ZoneSeverity, ZoneStageResultV2, ZoneStageStatus } from "../output/zoneStageTypes.js";
import { buildStageResultV2 } from "./buildStageResultV2.js";

function resolveStatus(operationCount: number): ZoneStageStatus {
  return operationCount > 0 ? "success" : "info";
}

function resolveSeverity(operationCount: number): ZoneSeverity {
  return operationCount > 0 ? "ok" : "warning";
}

function resolveCode(operationCount: number): ZoneCode {
  return operationCount > 0 ? "ZONE_OK" : "ZONE_SKIPPED";
}

function resolveSummary(operationCount: number): string {
  if (operationCount === 0) {
    return "Generated patch preview contains no operations.";
  }
  if (operationCount === 1) {
    return "Generated patch preview contains 1 operation.";
  }
  return `Generated patch preview contains ${operationCount} operations.`;
}

function resolveDetails(plan: GeneratedPatchPlan): string | undefined {
  if (plan.operations.length === 0) {
    return undefined;
  }

  return plan.operations
    .map((operation, index) => {
      const filePath =
        "filePath" in operation && typeof operation.filePath === "string"
          ? operation.filePath
          : "unknown";
      return `${index + 1}. ${operation.type} -> ${filePath}`;
    })
    .join("\n");
}

export function buildPreviewStageResult(plan: GeneratedPatchPlan): ZoneStageResultV2 {
  const operationCount = plan.operations.length;

  return buildStageResultV2({
    stage: "generated_patch_preview",
    status: resolveStatus(operationCount),
    severity: resolveSeverity(operationCount),
    code: resolveCode(operationCount),
    summary: resolveSummary(operationCount),
    details: resolveDetails(plan),
  });
}
