import { describe, expect, it } from "vitest";
import { resolveDailyUsdCap } from "./usdCapResolver.js";

describe("resolveDailyUsdCap", () => {
  it.each([[5, 5], [20, 10], [0, 10]])("captured TUI limit %s cannot exceed an environment ceiling", (selected, effective) => {
    expect(resolveDailyUsdCap({ userId: "local-dev", userOverride: selected, envValue: "10", enforceEnvCeiling: true }).capUsd).toBe(effective);
  });

  it("an unlimited environment setting permits a lower TUI limit", () => {
    expect(resolveDailyUsdCap({ userId: "local-dev", userOverride: 5, envValue: "0", enforceEnvCeiling: true }).capUsd).toBe(5);
  });

  it("the environment ceiling also bounds an organization policy", () => {
    expect(resolveDailyUsdCap({ userId: "local-dev", policyValue: 50, envValue: "10", enforceEnvCeiling: true }).capUsd).toBe(10);
  });

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

  it("policy $5 wins over user_override $20 and env $50", () => {
    const result = resolveDailyUsdCap({
      userId: "user-1",
      policyValue: 5,
      userOverride: 20,
      envValue: "50",
    });
    expect(result).toEqual({ capUsd: 5, source: "policy" });
  });

  it("policy 0 (unlimited) overrides everything", () => {
    const result = resolveDailyUsdCap({
      userId: "user-1",
      policyValue: 0,
      userOverride: 20,
      envValue: "50",
    });
    expect(result).toEqual({ capUsd: 0, source: "policy" });
  });

  it("no policy → falls through to user_override (regression check)", () => {
    const result = resolveDailyUsdCap({
      userId: "user-1",
      userOverride: 15,
      envValue: "50",
    });
    expect(result).toEqual({ capUsd: 15, source: "user_override" });
  });
});
