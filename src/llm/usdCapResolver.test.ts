import { describe, expect, it } from "vitest";
import { resolveDailyUsdCap } from "./usdCapResolver.js";

describe("resolveDailyUsdCap", () => {
  it("user override wins over env and default", () => {
    const result = resolveDailyUsdCap({
      userId: "user-1",
      userOverride: 25.0,
      envValue: "50",
    });
    expect(result).toEqual({ capUsd: 25.0, source: "user_override" });
  });

  it("user override of 0 means unlimited (not fallthrough)", () => {
    const result = resolveDailyUsdCap({
      userId: "user-1",
      userOverride: 0,
      envValue: "50",
    });
    expect(result).toEqual({ capUsd: 0, source: "user_override" });
  });

  it("env=0 means unlimited", () => {
    const result = resolveDailyUsdCap({
      userId: "user-1",
      envValue: "0",
    });
    expect(result).toEqual({ capUsd: 0, source: "env" });
  });

  it("no overrides → default $10.00", () => {
    const result = resolveDailyUsdCap({ userId: "user-1" });
    expect(result).toEqual({ capUsd: 10.0, source: "default" });
  });

  it("invalid env string falls through to default", () => {
    const result = resolveDailyUsdCap({
      userId: "user-1",
      envValue: "not-a-number",
    });
    expect(result).toEqual({ capUsd: 10.0, source: "default" });
  });

  it("negative user override falls through to env", () => {
    const result = resolveDailyUsdCap({
      userId: "user-1",
      userOverride: -5,
      envValue: "20",
    });
    expect(result).toEqual({ capUsd: 20.0, source: "env" });
  });
});
