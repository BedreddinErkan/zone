export type ZoneStage =
  | "decision"
  | "generated_patch_preview"
  | "generated_patch_conversion"
  | "apply";

export type ZoneStageStatus =
  | "success"
  | "failed"
  | "blocked"
  | "skipped"
  | "info";

export type ZoneStageResult = {
  stage: ZoneStage;
  status: ZoneStageStatus;
  summary: string;
  details?: string;
};

// ── v2 types ──────────────────────────────────────────────────────────────────

export type ZoneSeverity = "ok" | "warning" | "error" | "fatal";

export type ZoneCode =
  | "ZONE_OK"
  | "ZONE_BLOCKED_HIGH_RISK"
  | "ZONE_BLOCKED_SCHEMA_ERROR"
  | "ZONE_CONVERSION_FAILED"
  | "ZONE_CONVERSION_FAILED_PLACEHOLDER"
  | "ZONE_CONVERSION_FAILED_UNSUPPORTED"
  | "ZONE_APPLY_SUCCESS"
  | "ZONE_APPLY_PARTIAL"
  | "ZONE_APPLY_FAILED"
  | "ZONE_PREVIEW_ONLY"
  | "ZONE_SKIPPED";

export type ZoneTimestamps = {
  startedAt: string;
  completedAt: string;
  durationMs: number;
};

export type ZoneStageMeta = {
  stage: ZoneStage;
  version: "2.0";
  engine: "zone";
};

export type ZoneStageResultV2 = {
  stage: ZoneStage;
  status: ZoneStageStatus;
  severity: ZoneSeverity;
  code: ZoneCode;
  summary: string;
  details?: string;
  timestamps?: ZoneTimestamps;
  meta: ZoneStageMeta;
};

export type ZoneBundledResult = {
  engine: "zone";
  version: "2.0";
  overallStatus: ZoneStageStatus;
  overallSeverity: ZoneSeverity;
  timestamps?: ZoneTimestamps;
  stages: {
    decision?: ZoneStageResultV2;
    generated_patch_preview?: ZoneStageResultV2;
    generated_patch_conversion?: ZoneStageResultV2;
    apply?: ZoneStageResultV2;
  };
};