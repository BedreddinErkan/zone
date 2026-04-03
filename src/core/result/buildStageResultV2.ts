import type {
  ZoneBundledResult,
  ZoneCode,
  ZoneSeverity,
  ZoneStage,
  ZoneStageResultV2,
  ZoneStageStatus,
  ZoneTimestamps,
} from "../output/zoneStageTypes.js";

export function buildStageResultV2(input: {
  stage: ZoneStage;
  status: ZoneStageStatus;
  severity: ZoneSeverity;
  code: ZoneCode;
  summary: string;
  details?: string;
  timestamps?: ZoneTimestamps;
}): ZoneStageResultV2 {
  return {
    stage: input.stage,
    status: input.status,
    severity: input.severity,
    code: input.code,
    summary: input.summary,
    details: input.details,
    timestamps: input.timestamps,
    meta: {
      stage: input.stage,
      version: "2.0",
      engine: "zone",
    },
  };
}

export function buildBundledResult(input: {
  stages: ZoneBundledResult["stages"];
  timestamps?: ZoneTimestamps;
}): ZoneBundledResult {
  const stageList = Object.values(input.stages).filter(
    (s): s is ZoneStageResultV2 => s !== undefined
  );

  const hasFatal = stageList.some((s) => s.severity === "fatal");
  const hasError = stageList.some((s) => s.severity === "error");
  const hasWarning = stageList.some((s) => s.severity === "warning");

  const overallSeverity: ZoneSeverity = hasFatal
    ? "fatal"
    : hasError
    ? "error"
    : hasWarning
    ? "warning"
    : "ok";

  const hasBlocked = stageList.some((s) => s.status === "blocked");
  const hasFailed = stageList.some((s) => s.status === "failed");
  const allSuccess = stageList.every((s) => s.status === "success");

  const overallStatus: ZoneStageStatus = hasBlocked
    ? "blocked"
    : hasFailed
    ? "failed"
    : allSuccess
    ? "success"
    : "info";

  return {
    engine: "zone",
    version: "2.0",
    overallStatus,
    overallSeverity,
    timestamps: input.timestamps,
    stages: input.stages,
  };
}
