import { describe, expect, it } from "vitest";
import {
  buildBundledResult,
  buildStageResultV2,
} from "./buildStageResultV2.js";
import type { ZoneStageResultV2 } from "../output/zoneStageTypes.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeStage(
  overrides: Partial<ZoneStageResultV2> = {}
): ZoneStageResultV2 {
  return buildStageResultV2({
    stage: "decision",
    status: "success",
    severity: "ok",
    code: "ZONE_OK",
    summary: "All good",
    ...overrides,
  });
}

// ── buildStageResultV2 ────────────────────────────────────────────────────────

describe("buildStageResultV2", () => {
  it("returns the correct shape with all required fields", () => {
    const result = buildStageResultV2({
      stage: "apply",
      status: "success",
      severity: "ok",
      code: "ZONE_APPLY_SUCCESS",
      summary: "Apply succeeded",
    });

    expect(result.stage).toBe("apply");
    expect(result.status).toBe("success");
    expect(result.severity).toBe("ok");
    expect(result.code).toBe("ZONE_APPLY_SUCCESS");
    expect(result.summary).toBe("Apply succeeded");
    expect(result.meta).toBeDefined();
  });

  it("meta always has engine: 'zone', version: '2.0', and stage matching input", () => {
    const result = buildStageResultV2({
      stage: "generated_patch_conversion",
      status: "failed",
      severity: "error",
      code: "ZONE_CONVERSION_FAILED",
      summary: "Conversion failed",
    });

    expect(result.meta.engine).toBe("zone");
    expect(result.meta.version).toBe("2.0");
    expect(result.meta.stage).toBe("generated_patch_conversion");
  });

  it("details is absent when not provided", () => {
    const result = buildStageResultV2({
      stage: "decision",
      status: "success",
      severity: "ok",
      code: "ZONE_OK",
      summary: "OK",
    });

    expect(result.details).toBeUndefined();
  });

  it("timestamps is absent when not provided", () => {
    const result = buildStageResultV2({
      stage: "decision",
      status: "success",
      severity: "ok",
      code: "ZONE_OK",
      summary: "OK",
    });

    expect(result.timestamps).toBeUndefined();
  });

  it("includes details and timestamps when provided", () => {
    const ts = { startedAt: "2026-04-03T00:00:00Z", completedAt: "2026-04-03T00:00:01Z", durationMs: 1000 };
    const result = buildStageResultV2({
      stage: "apply",
      status: "success",
      severity: "ok",
      code: "ZONE_APPLY_SUCCESS",
      summary: "Done",
      details: "All files written",
      timestamps: ts,
    });

    expect(result.details).toBe("All files written");
    expect(result.timestamps).toEqual(ts);
  });
});

// ── buildBundledResult ────────────────────────────────────────────────────────

describe("buildBundledResult", () => {
  it("engine is always 'zone' and version is always '2.0'", () => {
    const result = buildBundledResult({ stages: {} });
    expect(result.engine).toBe("zone");
    expect(result.version).toBe("2.0");
  });

  it("overallSeverity is 'fatal' when any stage has severity 'fatal'", () => {
    const result = buildBundledResult({
      stages: {
        decision: makeStage({ severity: "fatal", status: "failed", code: "ZONE_BLOCKED_HIGH_RISK" }),
        apply: makeStage({ severity: "ok" }),
      },
    });
    expect(result.overallSeverity).toBe("fatal");
  });

  it("overallSeverity is 'error' when any stage has severity 'error' (no fatal)", () => {
    const result = buildBundledResult({
      stages: {
        decision: makeStage({ severity: "error", status: "failed", code: "ZONE_CONVERSION_FAILED" }),
        apply: makeStage({ severity: "warning" }),
      },
    });
    expect(result.overallSeverity).toBe("error");
  });

  it("overallSeverity is 'warning' when any stage has severity 'warning' (no error or fatal)", () => {
    const result = buildBundledResult({
      stages: {
        decision: makeStage({ severity: "warning" }),
        apply: makeStage({ severity: "ok" }),
      },
    });
    expect(result.overallSeverity).toBe("warning");
  });

  it("overallSeverity is 'ok' when all stages have severity 'ok'", () => {
    const result = buildBundledResult({
      stages: {
        decision: makeStage({ severity: "ok" }),
        apply: makeStage({ severity: "ok" }),
      },
    });
    expect(result.overallSeverity).toBe("ok");
  });

  it("overallSeverity is 'ok' when stages is empty", () => {
    const result = buildBundledResult({ stages: {} });
    expect(result.overallSeverity).toBe("ok");
  });

  it("overallStatus is 'blocked' when any stage has status 'blocked'", () => {
    const result = buildBundledResult({
      stages: {
        decision: makeStage({ status: "blocked", severity: "fatal", code: "ZONE_BLOCKED_HIGH_RISK" }),
        apply: makeStage({ status: "success" }),
      },
    });
    expect(result.overallStatus).toBe("blocked");
  });

  it("overallStatus is 'failed' when any stage has status 'failed' (no blocked)", () => {
    const result = buildBundledResult({
      stages: {
        decision: makeStage({ status: "failed", severity: "error", code: "ZONE_CONVERSION_FAILED" }),
        apply: makeStage({ status: "success" }),
      },
    });
    expect(result.overallStatus).toBe("failed");
  });

  it("overallStatus is 'success' when all stages have status 'success'", () => {
    const result = buildBundledResult({
      stages: {
        decision: makeStage({ status: "success" }),
        apply: makeStage({ status: "success", code: "ZONE_APPLY_SUCCESS" }),
      },
    });
    expect(result.overallStatus).toBe("success");
  });

  it("overallStatus is 'info' when stages are mixed non-blocked/non-failed/non-all-success", () => {
    const result = buildBundledResult({
      stages: {
        decision: makeStage({ status: "success" }),
        apply: makeStage({ status: "skipped", code: "ZONE_SKIPPED" }),
      },
    });
    expect(result.overallStatus).toBe("info");
  });

  it("passes through the stages map unchanged", () => {
    const decisionStage = makeStage({ stage: "decision" });
    const result = buildBundledResult({
      stages: { decision: decisionStage },
    });
    expect(result.stages.decision).toEqual(decisionStage);
  });

  it("includes timestamps when provided", () => {
    const ts = { startedAt: "2026-04-03T00:00:00Z", completedAt: "2026-04-03T00:00:05Z", durationMs: 5000 };
    const result = buildBundledResult({ stages: {}, timestamps: ts });
    expect(result.timestamps).toEqual(ts);
  });

  it("timestamps is absent when not provided", () => {
    const result = buildBundledResult({ stages: {} });
    expect(result.timestamps).toBeUndefined();
  });
});
