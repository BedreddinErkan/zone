import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../usage/usageTracker.js", () => ({
  getUsage: vi.fn(),
  readRecords: vi.fn(() => []),
  getRunCost: vi.fn(() => 0),
  recordExecution: vi.fn(),
  readDailyUsdCapOverride: vi.fn(() => undefined),
}));

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: vi.fn(() => undefined),
}));

vi.mock("./policyLoader.js", () => ({
  loadOrgPolicy: vi.fn(() => ({ ok: true, policy: null, source: "absent" })),
}));

import { checkDailyCap, routeCapGate } from "./checkDailyCap.js";
import { getUsage } from "../usage/usageTracker.js";
import { readDailyUsdCapOverride } from "../visual/tierSettings.js";
import { loadOrgPolicy } from "./policyLoader.js";

const mockGetUsage = vi.mocked(getUsage);
const mockReadOverride = vi.mocked(readDailyUsdCapOverride);
const mockLoadOrgPolicy = vi.mocked(loadOrgPolicy);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ZONE_DAILY_USD_CAP;
  delete process.env.ZONE_ORG_POLICY_PATH;
  mockGetUsage.mockResolvedValue({
    period: "day",
    totalRuns: 5,
    totalTokens: 1000,
    totalCostUsd: 0,
    byProvider: {},
    byModel: {},
  });
  mockReadOverride.mockReturnValue(undefined);
  mockLoadOrgPolicy.mockReturnValue({ ok: true, policy: null, source: "absent" });
});

afterEach(() => {
  delete process.env.ZONE_DAILY_USD_CAP;
  delete process.env.ZONE_ORG_POLICY_PATH;
});

describe("checkDailyCap", () => {
  it("allows when capUsd=0 (unlimited) without reading usage", async () => {
    const result = await checkDailyCap({ userId: "u1", envValue: "0" });
    expect(result.allowed).toBe(true);
    expect(mockGetUsage).not.toHaveBeenCalled();
  });

  it("allows when spend < cap (env source)", async () => {
    mockGetUsage.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 0.5,
      byProvider: {}, byModel: {},
    });
    const result = await checkDailyCap({ userId: "u1", envValue: "10" });
    expect(result.allowed).toBe(true);
  });

  it("blocks when spend >= cap (env source)", async () => {
    mockGetUsage.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 10.5,
      byProvider: {}, byModel: {},
    });
    const result = await checkDailyCap({ userId: "u1", envValue: "10" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.spentUsd).toBe(10.5);
      expect(result.capUsd).toBe(10);
      expect(result.outcome.userFacingMessage).toContain("$10.50");
      expect(result.outcome.userFacingMessage).toContain("$10.00");
      expect(result.outcome.canResume).toBe(true);
      expect(result.outcome.resumeHint).toContain("ZONE_DAILY_USD_CAP");
    }
  });

  it("policy overrides env when policyValue is set", async () => {
    mockGetUsage.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 3.0,
      byProvider: {}, byModel: {},
    });
    // env cap = $100, policy cap = $5 → policy wins → $3 < $5 → allowed
    const resultAllowed = await checkDailyCap({ userId: "u1", policyValue: 5, envValue: "100" });
    expect(resultAllowed.allowed).toBe(true);

    // env cap = $100, policy cap = $2 → policy wins → $3 >= $2 → blocked
    const resultBlocked = await checkDailyCap({ userId: "u1", policyValue: 2, envValue: "100" });
    expect(resultBlocked.allowed).toBe(false);
  });

  it("userOverride overrides env when policyValue is absent", async () => {
    mockGetUsage.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 8.0,
      byProvider: {}, byModel: {},
    });
    // env cap = $100, user override = $7 → override wins → $8 >= $7 → blocked
    const result = await checkDailyCap({ userId: "u1", userOverride: 7, envValue: "100" });
    expect(result.allowed).toBe(false);
  });

  it("falls back to $10 default when no source is provided", async () => {
    mockGetUsage.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 9.5,
      byProvider: {}, byModel: {},
    });
    const result = await checkDailyCap({ userId: "u1" });
    expect(result.allowed).toBe(true); // 9.5 < 10.0 default
  });

  it("blocks at exactly cap (>=, not >)", async () => {
    mockGetUsage.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 5.0,
      byProvider: {}, byModel: {},
    });
    const result = await checkDailyCap({ userId: "u1", envValue: "5" });
    expect(result.allowed).toBe(false);
  });
});

describe("routeCapGate", () => {
  it("reads policy from env, user override, and ZONE_DAILY_USD_CAP", async () => {
    process.env.ZONE_DAILY_USD_CAP = "3";
    mockGetUsage.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 4.0,
      byProvider: {}, byModel: {},
    });
    mockLoadOrgPolicy.mockReturnValue({ ok: true, policy: null, source: "absent" });
    mockReadOverride.mockReturnValue(undefined);

    const result = await routeCapGate("u1", "run-abc");
    expect(result.allowed).toBe(false);
  });

  it("policy value from org policy file overrides ZONE_DAILY_USD_CAP", async () => {
    process.env.ZONE_DAILY_USD_CAP = "1"; // low env cap
    mockGetUsage.mockResolvedValue({
      period: "day", totalRuns: 1, totalTokens: 100, totalCostUsd: 0.5,
      byProvider: {}, byModel: {},
    });
    mockLoadOrgPolicy.mockReturnValue({
      ok: true,
      policy: { dailyUsdCap: 50 },  // policy cap overrides env → $0.5 < $50 → allowed
      source: "file",
      path: "/tmp/policy.json",
    });
    const result = await routeCapGate("u1");
    expect(result.allowed).toBe(true);
  });
});
