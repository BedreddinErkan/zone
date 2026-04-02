import { describe, expect, it } from "vitest";
import { runAgent } from "./runAgent.js";

describe("runAgent", () => {
  it("returns safe_to_apply for a low-risk rename task", async () => {
    const result = await runAgent({
      task: "rename helper function"
    });

    expect(result.task).toBe("rename helper function");
    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.explanation).toContain("SAFE TO APPLY");
    expect(result.recommendation).toBe(
      "Patch can be applied automatically under current safeguards."
    );

    expect(result.trace).toBeDefined();
    expect(result.trace.signals).toEqual(["low_risk"]);
    expect(result.trace.riskScore).toBe(result.risk.score);
    expect(result.trace.confidenceScore).toBe(result.confidence.score);
    expect(result.trace.appliedPenalties).toEqual([]);
  });

  it("returns safe_to_apply for a general low-signal endpoint task", async () => {
    const result = await runAgent({
      task: "add update endpoint for treatment timeline"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.trace).toBeDefined();
    expect(result.trace.riskScore).toBe(result.risk.score);
    expect(result.trace.confidenceScore).toBe(result.confidence.score);
  });

  it("returns preview_only for schema-related tasks", async () => {
    const result = await runAgent({
      task: "add schema migration for treatment timeline"
    });

    expect(result.decision.mode).toBe("preview_only");
    expect(result.explanation).toContain("PREVIEW ONLY");
    expect(result.recommendation).toBe(
      "Preview the patch and verify the affected scope before any apply step."
    );

    expect(result.trace).toBeDefined();
    expect(result.trace.signals).toContain("schema");
    expect(result.trace.riskScore).toBe(result.risk.score);
    expect(result.trace.confidenceScore).toBe(result.confidence.score);
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "schema",
      impact: -25
    });
  });

  it("returns preview_only for critical domain updates", async () => {
    const result = await runAgent({
      task: "update payment service logic"
    });

    expect(result.decision.mode).toBe("preview_only");
    expect(result.trace).toBeDefined();
    expect(result.trace.signals).toContain("critical_domain");
  });

  it("returns blocked for destructive database tasks", async () => {
    const result = await runAgent({
      task: "delete user table from database"
    });

    expect(result.task).toBe("delete user table from database");
    expect(result.decision.mode).toBe("blocked");
    expect(result.explanation).toContain("BLOCKED");
    expect(result.recommendation).toBe(
      "Do not auto-apply. Manual review is required before making changes."
    );
    expect(result.topRisks.length).toBeGreaterThan(0);

    expect(result.trace).toBeDefined();
    expect(result.trace.signals).toContain("destructive");
    expect(result.trace.riskScore).toBe(result.risk.score);
    expect(result.trace.confidenceScore).toBe(result.confidence.score);
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "destructive",
      impact: -50
    });
  });

  it("returns safe_to_apply for unknown low-signal tasks", async () => {
    const result = await runAgent({
      task: "do something"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.trace).toBeDefined();
    expect(result.trace.riskScore).toBe(result.risk.score);
    expect(result.trace.confidenceScore).toBe(result.confidence.score);
  });

  // ---------------------------------------------------------------------------
  // mass_scope signal — integration
  // ---------------------------------------------------------------------------

  it("'delete all user sessions' → blocked (destructive + mass_scope = 75)", async () => {
    const result = await runAgent({ task: "delete all user sessions" });

    expect(result.decision.mode).toBe("blocked");
    expect(result.risk.breakdown.destructive).toBe(50);
    expect(result.risk.breakdown.massScope).toBe(25);
    expect(result.risk.score).toBe(75);
    expect(result.topRisks.some((r) => r.title === "Mass-scope operation")).toBe(true);

    expect(result.trace.signals).toContain("destructive");
    expect(result.trace.signals).toContain("mass_scope");
    expect(result.trace.riskScore).toBe(75);
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "destructive",
      impact: -50
    });
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "mass_scope",
      impact: -25
    });
  });

  it("'purge all cache' → preview_only (mass_scope only = 25)", async () => {
    const result = await runAgent({ task: "purge all cache" });

    expect(result.decision.mode).toBe("preview_only");
    expect(result.risk.breakdown.massScope).toBe(25);
    expect(result.risk.breakdown.destructive).toBe(0);

    expect(result.trace.signals).toContain("mass_scope");
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "mass_scope",
      impact: -25
    });
  });

  it("'delete user session' (tekil) → preview_only, mass_scope yok", async () => {
    const result = await runAgent({ task: "delete user session" });

    expect(result.decision.mode).toBe("preview_only");
    expect(result.risk.breakdown.massScope).toBe(0);
    expect(result.topRisks.every((r) => r.title !== "Mass-scope operation")).toBe(true);

    expect(result.trace.signals).not.toContain("mass_scope");
  });

  it("mass_scope topRisk reason içeriği doğru", async () => {
    const result = await runAgent({ task: "wipe all data" });

    const massRisk = result.topRisks.find((r) => r.title === "Mass-scope operation");
    expect(massRisk).toBeDefined();
    expect(massRisk?.severity).toBe("high");
    expect(massRisk?.reason).toContain("irreversible");

    expect(result.trace.signals).toContain("mass_scope");
  });

it("explanation mass-scope reason semantiğini koruyor", async () => {
  const result = await runAgent({ task: "purge all records" });

  expect(result.trace.signals).toContain("mass_scope");
  expect(result.reasonCodes).toContain("PREVIEW_MASS_SCOPE_CHANGE");
  expect(result.explanation).toContain("Why:");
  expect(result.explanation.toLowerCase()).toMatch(/many records|broad surface area/);
});

describe("runAgent explanation consistency", () => {
  it('adds a "Why:" line for blocked results', async () => {
    const result = await runAgent({
      task: "drop database schema and delete all user records"
    });

    expect(result.decision.mode).toBe("blocked");
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");
  });

  it('adds a "Why:" line for preview_only results', async () => {
    const result = await runAgent({
      task: "update auth schema for all accounts"
    });

    expect(result.decision.mode).toBe("preview_only");
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");
  });

  it('adds a "Why:" line for safe_to_apply results', async () => {
    const result = await runAgent({
      task: "rename local helper function in one file"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");
  });

  it("keeps explanation semantically aligned with reason codes", async () => {
    const result = await runAgent({
      task: "drop billing table"
    });

    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");

    if (result.reasonCodes.includes("BLOCKED_DESTRUCTIVE_OPERATION")) {
      expect(result.explanation.toLowerCase()).toMatch(/destructive|delete|drop/);
    }

    if (result.reasonCodes.includes("BLOCKED_SCHEMA_RISK")) {
      expect(result.explanation.toLowerCase()).toMatch(/schema/);
    }
  });

describe("runAgent explanation consistency", () => {
  it('adds a "Why:" line for blocked results', async () => {
    const result = await runAgent({
      task: "drop database schema and delete all user records"
    });

    expect(result.decision.mode).toBe("blocked");
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");
  });

  it('adds a "Why:" line for preview_only results', async () => {
    const result = await runAgent({
      task: "update auth schema for all accounts"
    });

    expect(result.decision.mode).toBe("preview_only");
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");
  });

  it('adds a "Why:" line for safe_to_apply results', async () => {
    const result = await runAgent({
      task: "rename local helper function in one file"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");
  });

  it("keeps explanation semantically aligned with reason codes", async () => {
    const result = await runAgent({
      task: "drop billing schema"
    });

    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");

    if (result.reasonCodes.includes("BLOCKED_DESTRUCTIVE_OPERATION")) {
      expect(result.explanation.toLowerCase()).toMatch(/destructive|delete|drop/);
    }

    if (result.reasonCodes.includes("BLOCKED_SCHEMA_RISK")) {
      expect(result.explanation.toLowerCase()).toMatch(/schema/);
    }
  });
});
});

  // ---------------------------------------------------------------------------
  // buildExplanation v2 — multi-line integration
  // ---------------------------------------------------------------------------
});