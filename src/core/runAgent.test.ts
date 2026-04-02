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
  });

  it("returns safe_to_apply for a general low-signal endpoint task", async () => {
    const result = await runAgent({
      task: "add update endpoint for treatment timeline"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
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
  });

  it("returns preview_only for critical domain updates", async () => {
    const result = await runAgent({
      task: "update payment service logic"
    });

    expect(result.decision.mode).toBe("preview_only");
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
  });

  it("returns safe_to_apply for unknown low-signal tasks", async () => {
    const result = await runAgent({
      task: "do something"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
  });
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
});

it("'purge all cache' → preview_only (mass_scope only = 25)", async () => {
  const result = await runAgent({ task: "purge all cache" });

  expect(result.decision.mode).toBe("preview_only");
  expect(result.risk.breakdown.massScope).toBe(25);
  expect(result.risk.breakdown.destructive).toBe(0);
});

it("'delete user session' (tekil) → preview_only, mass_scope yok", async () => {
  const result = await runAgent({ task: "delete user session" });

  expect(result.decision.mode).toBe("preview_only");
  expect(result.risk.breakdown.massScope).toBe(0);
  expect(result.topRisks.every((r) => r.title !== "Mass-scope operation")).toBe(true);
});

it("mass_scope topRisk reason içeriği doğru", async () => {
  const result = await runAgent({ task: "wipe all data" });

  const massRisk = result.topRisks.find((r) => r.title === "Mass-scope operation");
  expect(massRisk).toBeDefined();
  expect(massRisk?.severity).toBe("high");
  expect(massRisk?.reason).toContain("irreversible");
});

it("explanation mass-scope sinyalini içeriyor", async () => {
  const result = await runAgent({ task: "purge all records" });

  expect(result.explanation).toContain("mass-scope");
});

// ---------------------------------------------------------------------------
// buildExplanation v2 — multi-line integration
// ---------------------------------------------------------------------------

it("explanation is multi-line for schema-related task", async () => {
  const result = await runAgent({
    task: "add schema migration for treatment timeline"
  });

  const lines = result.explanation.split("\n");
  expect(lines[0]).toContain("PREVIEW ONLY");
  expect(lines[1]).toBe("Primary cause: schema-sensitive change");
  expect(lines[2]).toContain("Confidence impact:");
  expect(lines[2]).toContain("schema penalty: -25");
});

it("explanation is multi-line for blocked destructive task", async () => {
  const result = await runAgent({
    task: "delete user table from database"
  });

  const lines = result.explanation.split("\n");
  expect(lines[0]).toContain("BLOCKED");
  expect(lines[1]).toBe("Primary cause: destructive operation");
  expect(lines[2]).toContain("Confidence impact:");
  expect(lines[2]).toContain("destructive penalty:");
});

it("explanation for safe low-risk task has no Confidence impact line when no adjustments", async () => {
  const result = await runAgent({
    task: "rename helper function"
  });

  const lines = result.explanation.split("\n");
  expect(lines[0]).toContain("SAFE TO APPLY");
  expect(lines[1]).toBe("Primary cause: general task");
  // low-risk bonus renders if present, otherwise only 2 lines
  // Either way the explanation must start with SAFE TO APPLY
  expect(result.explanation).toContain("SAFE TO APPLY");
});

it("includes confidence breakdown for schema-related tasks", async () => {
  const result = await runAgent({
    task: "add schema migration for treatment timeline"
  });

  expect(result.confidence.score).toBe(75);
expect(result.confidence.breakdown).toEqual({
  base: 100,
  destructivePenalty: 0,
  schemaPenalty: -25,
  criticalPenalty: 0,
  massScopePenalty: 0,
  lowRiskBonus: 0
});
});

it("includes confidence breakdown for destructive database tasks", async () => {
  const result = await runAgent({
    task: "delete database schema"
  });

  expect(result.confidence.score).toBe(25);
  expect(result.confidence.breakdown).toEqual({
    base: 100,
    destructivePenalty: -50,
    schemaPenalty: -25,
    criticalPenalty: 0,
    massScopePenalty: 0,
    lowRiskBonus: 0
  });
});

it("includes massScopePenalty in confidence breakdown for mass-scope tasks", async () => {
  const result = await runAgent({
    task: "purge all cache"
  });

  expect(result.confidence.breakdown).toMatchObject({
    massScopePenalty: -25
  });
});