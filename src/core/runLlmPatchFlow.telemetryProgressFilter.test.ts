/**
 * Phase F1.4 C3 — telemetry JSON leak suppression.
 *
 * toolExecutor side-channels diagnostic events through the same
 * onProgress callback the UI uses to surface tool_call titles. Without
 * filtering, the raw JSON renders as a chat line. The helper below
 * detects zone-internal telemetry payloads so the runLlmPatchFlow
 * onProgress callback can drop them before they reach the chat.
 */

import { describe, expect, it } from "vitest";
import { isZoneInternalTelemetryProgress } from "./runLlmPatchFlow.js";

describe("Phase F1.4 C3 — isZoneInternalTelemetryProgress", () => {
  it("suppresses identity-swap allowed-as-rename telemetry", () => {
    const payload = JSON.stringify({
      event: "zone-tool-apply-patch-identity-swap-allowed-as-rename",
      filePath: "src/foo.ts",
      block: 1,
      sizeRatio: 0.9,
      lineDelta: 0,
    });
    expect(isZoneInternalTelemetryProgress(payload)).toBe(true);
  });

  it("suppresses identity-swap blocked telemetry", () => {
    const payload = JSON.stringify({
      event: "zone-tool-apply-patch-identity-swap-blocked",
      filePath: "src/bar.ts",
    });
    expect(isZoneInternalTelemetryProgress(payload)).toBe(true);
  });

  it("suppresses any zone-* prefixed event payload", () => {
    expect(isZoneInternalTelemetryProgress('{"event":"zone-staging-flush","files":3}')).toBe(true);
    expect(isZoneInternalTelemetryProgress('{"event":"zone-tool-write-overwrite-prompt"}')).toBe(true);
    expect(isZoneInternalTelemetryProgress('{ "event" : "zone-anything" }')).toBe(true);
  });

  it("allows non-telemetry progress messages through (user-facing)", () => {
    expect(isZoneInternalTelemetryProgress("Generating a localized patch")).toBe(false);
    expect(isZoneInternalTelemetryProgress("✎ Patching files.ts...")).toBe(false);
    expect(isZoneInternalTelemetryProgress("[tool] read_file: src/x.ts")).toBe(false);
    expect(isZoneInternalTelemetryProgress("")).toBe(false);
    expect(isZoneInternalTelemetryProgress(undefined)).toBe(false);
    expect(isZoneInternalTelemetryProgress(null)).toBe(false);
  });

  it("allows JSON without a zone-* event field (e.g. external tool output)", () => {
    expect(isZoneInternalTelemetryProgress('{"status":"ok","count":3}')).toBe(false);
    expect(isZoneInternalTelemetryProgress('{"event":"something-else"}')).toBe(false);
    // Edge case: malformed JSON-ish text with no event field — not telemetry.
    expect(isZoneInternalTelemetryProgress('{"foo": "bar"')).toBe(false);
  });

  it("handles leading whitespace gracefully", () => {
    expect(isZoneInternalTelemetryProgress('  {"event":"zone-staging-flush"}')).toBe(true);
    expect(isZoneInternalTelemetryProgress("\n\t  hello")).toBe(false);
  });
});
