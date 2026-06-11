import { describe, it, expect, afterEach, vi } from "vitest";
import { responsesEnabled } from "./responsesEnabled.js";

describe("responsesEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns true when ZONE_OPENAI_RESPONSES === "1"', () => {
    vi.stubEnv("ZONE_OPENAI_RESPONSES", "1");
    expect(responsesEnabled()).toBe(true);
  });

  it("returns false when ZONE_OPENAI_RESPONSES is absent", () => {
    vi.stubEnv("ZONE_OPENAI_RESPONSES", "");
    expect(responsesEnabled()).toBe(false);
  });

  it('returns false when ZONE_OPENAI_RESPONSES is "0"', () => {
    vi.stubEnv("ZONE_OPENAI_RESPONSES", "0");
    expect(responsesEnabled()).toBe(false);
  });

  it('returns false when ZONE_OPENAI_RESPONSES is "true" (only "1" activates)', () => {
    vi.stubEnv("ZONE_OPENAI_RESPONSES", "true");
    expect(responsesEnabled()).toBe(false);
  });
});
