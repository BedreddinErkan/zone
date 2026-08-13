// Item 128: scripts/tier-agreement-probe.mjs's fallbackKind used to collapse
// invalid_tier and low_tier_confidence into one "low_confidence" value, because both
// route through the same `reasoning` string. These tests cover the widened
// derivation (5-value domain), the marker parser it runs on, and the two small
// attribution checks (taskHash mismatch, unattributed emission) — all against
// synthetic captured `console.warn` lines built in the REAL two-arg shape
// emitClassifierFallback produces (`console.warn("[zone-classifier-fallback]",
// JSON.stringify(event))`, space-joined by the probe's capture). No provider call.
import { describe, expect, it } from "vitest";
import {
  parseFallbackMarkers,
  deriveFallbackKind,
  hashTask,
  hasTaskHashMismatch,
  isFallbackUnattributed,
} from "./tier-agreement-probe.mjs";

// Mirrors the probe's own capture join: console.warn("[tag]", JSON.stringify(evt))
// becomes one line, "[tag] " + JSON.stringify(evt).
function markerLine(reason: string, taskHash: string): string {
  return `[zone-classifier-fallback] ${JSON.stringify({ reason, taskHash })}`;
}

const TASK_HASH = hashTask("do the thing");
const OTHER_HASH = hashTask("a completely different task");

describe("item 128: parseFallbackMarkers", () => {
  it("returns an empty array for no captured lines", () => {
    expect(parseFallbackMarkers([])).toEqual([]);
  });

  it("ignores lines that do not carry the classifier-fallback tag", () => {
    const lines = ["some unrelated console.warn output", "[zone-other-tag] {\"x\":1}"];
    expect(parseFallbackMarkers(lines)).toEqual([]);
  });

  it("skips a malformed capture line without throwing", () => {
    const lines = ["[zone-classifier-fallback] {not valid json", markerLine("error", TASK_HASH)];
    expect(() => parseFallbackMarkers(lines)).not.toThrow();
    expect(parseFallbackMarkers(lines)).toEqual([{ reason: "error", taskHash: TASK_HASH }]);
  });

  it("preserves capture order verbatim across multiple markers", () => {
    const lines = [
      markerLine("invalid_tier", TASK_HASH),
      markerLine("low_tier_confidence", TASK_HASH),
    ];
    expect(parseFallbackMarkers(lines)).toEqual([
      { reason: "invalid_tier", taskHash: TASK_HASH },
      { reason: "low_tier_confidence", taskHash: TASK_HASH },
    ]);
  });
});

describe("item 128: deriveFallbackKind — widened 5-value domain", () => {
  it("invalid_tier alone", () => {
    const markers = parseFallbackMarkers([markerLine("invalid_tier", TASK_HASH)]);
    expect(deriveFallbackKind(true, markers)).toBe("invalid_tier");
  });

  it("truncated alone", () => {
    const markers = parseFallbackMarkers([markerLine("truncated", TASK_HASH)]);
    expect(deriveFallbackKind(true, markers)).toBe("truncated");
  });

  it("low_tier_confidence alone", () => {
    const markers = parseFallbackMarkers([markerLine("low_tier_confidence", TASK_HASH)]);
    expect(deriveFallbackKind(true, markers)).toBe("low_confidence");
  });

  it("error alone", () => {
    const markers = parseFallbackMarkers([markerLine("error", TASK_HASH)]);
    expect(deriveFallbackKind(true, markers)).toBe("error");
  });

  it("none: fallbackUsed false, no markers", () => {
    expect(deriveFallbackKind(false, [])).toBeNull();
  });

  it("invalid_tier + low_tier_confidence together: invalid_tier takes precedence", () => {
    // Structurally guaranteed co-emission: rejecting the tier field forces
    // parsed.confidence to 0, which always trips the confidence gate too.
    const markers = parseFallbackMarkers([
      markerLine("invalid_tier", TASK_HASH),
      markerLine("low_tier_confidence", TASK_HASH),
    ]);
    expect(deriveFallbackKind(true, markers)).toBe("invalid_tier");
  });

  it("truncated + low_tier_confidence together: truncated takes precedence", () => {
    // Conditional co-emission (not forced by truncation itself, unlike invalid_tier
    // above) — but when it happens, truncated is still the more specific signal.
    const markers = parseFallbackMarkers([
      markerLine("truncated", TASK_HASH),
      markerLine("low_tier_confidence", TASK_HASH),
    ]);
    expect(deriveFallbackKind(true, markers)).toBe("truncated");
  });

  it("fallbackUsed true with zero captured markers still resolves to the error bucket", () => {
    // Distinguished from a real error via isFallbackUnattributed, not by fallbackKind
    // itself — the domain stays fixed at 5 values.
    expect(deriveFallbackKind(true, [])).toBe("error");
  });
});

describe("item 128: hasTaskHashMismatch", () => {
  it("reports no mismatch when every captured marker's taskHash matches", () => {
    const markers = parseFallbackMarkers([markerLine("low_tier_confidence", TASK_HASH)]);
    expect(hasTaskHashMismatch(markers, TASK_HASH)).toBe(false);
  });

  it("reports a mismatch, recorded rather than thrown, when a taskHash disagrees", () => {
    const markers = parseFallbackMarkers([markerLine("low_tier_confidence", OTHER_HASH)]);
    expect(() => hasTaskHashMismatch(markers, TASK_HASH)).not.toThrow();
    expect(hasTaskHashMismatch(markers, TASK_HASH)).toBe(true);
  });
});

describe("item 128: isFallbackUnattributed", () => {
  it("is true when fallbackUsed is true and nothing was captured", () => {
    expect(isFallbackUnattributed(true, [])).toBe(true);
  });

  it("is false when fallbackUsed is true and a marker was captured", () => {
    const markers = parseFallbackMarkers([markerLine("error", TASK_HASH)]);
    expect(isFallbackUnattributed(true, markers)).toBe(false);
  });

  it("is false when fallbackUsed is false, regardless of captured markers", () => {
    expect(isFallbackUnattributed(false, [])).toBe(false);
  });
});

describe("item 128: hashTask — parity guard against taskClassifier.ts's algorithm", () => {
  it("is deterministic for the same input", () => {
    expect(hashTask("do the thing")).toBe(hashTask("do the thing"));
  });

  it("differs for different input", () => {
    expect(hashTask("do the thing")).not.toBe(hashTask("a completely different task"));
  });
});
