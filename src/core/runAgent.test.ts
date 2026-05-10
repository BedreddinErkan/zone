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

  // Phase J.1: schema / critical_domain / mass_scope (single-target) signals
  // no longer gate apply. They still surface in trace.signals + topRisks for
  // observability, but the decision is safe_to_apply unless score ≥ 71.
  it("emits the schema signal but produces safe_to_apply (Phase J.1)", async () => {
    const result = await runAgent({
      task: "add schema migration for treatment timeline"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.trace).toBeDefined();
    expect(result.trace.signals).toContain("schema");
    expect(result.trace.riskScore).toBe(result.risk.score);
    expect(result.trace.confidenceScore).toBe(result.confidence.score);
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "schema",
      impact: -25
    });
  });

  it("emits the critical_domain signal but produces safe_to_apply (Phase J.1)", async () => {
    const result = await runAgent({
      task: "update payment service logic"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.trace).toBeDefined();
    expect(result.trace.signals).toContain("critical_domain");
  });

  it("destructive single-target task: signal recorded, decision safe_to_apply (Phase J.1)", async () => {
    const result = await runAgent({
      task: "delete user table from database"
    });

    expect(result.task).toBe("delete user table from database");
    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.risk.score).toBe(70);

    expect(result.trace).toBeDefined();
    expect(result.trace.signals).toContain("destructive");
    expect(result.trace.riskScore).toBe(result.risk.score);
    expect(result.trace.confidenceScore).toBe(result.confidence.score);
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "destructive",
      impact: -35
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
    expect(result.risk.breakdown.massScope).toBe(40);
    expect(result.risk.score).toBe(100);
    expect(result.topRisks.some((r) => r.title === "Mass-scope operation")).toBe(true);

    expect(result.trace.signals).toContain("destructive");
    expect(result.trace.signals).toContain("mass_scope");
    expect(result.trace.riskScore).toBe(100);
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "destructive",
      impact: -50
    });
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "mass_scope",
      impact: -40
    });
  });

  it("'purge all cache' → blocked (destructive + mass_scope, score=100)", async () => {
    const result = await runAgent({ task: "purge all cache" });

    expect(result.decision.mode).toBe("blocked");
    expect(result.risk.breakdown.massScope).toBe(40);
    expect(result.risk.breakdown.destructive).toBe(50);
    expect(result.risk.score).toBe(100);

    expect(result.trace.signals).toContain("destructive");
    expect(result.trace.signals).toContain("mass_scope");
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "destructive",
      impact: -50
    });
    expect(result.trace.appliedPenalties).toContainEqual({
      type: "mass_scope",
      impact: -40
    });
  });

  // Phase J.1: single-target destructive tasks no longer route to preview_only.
  // The destructive signal is still recorded; mass_scope is correctly absent.
  it("'delete user session' (single target): no mass_scope, decision safe_to_apply (Phase J.1)", async () => {
    const result = await runAgent({ task: "delete user session" });

    expect(result.decision.mode).toBe("safe_to_apply");
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
  expect(result.decision.mode).toBe("blocked");
expect(result.reasonCodes).toContain("BLOCKED_DESTRUCTIVE_OPERATION");
  expect(result.explanation).toContain("Why:");
expect(result.explanation.toLowerCase()).toMatch(/destructive|irreversible|high risk/);
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

  // Phase J.1: the previous "preview_only" Why-line test (using auth schema)
  // is removed — schema-touching tasks now produce safe_to_apply with no
  // reason codes (confidence drop from schema penalty doesn't trigger
  // SAFE_HIGH_CONFIDENCE either), which would leave the explanation without
  // a "Why:" line. The remaining safe_to_apply Why-line test below covers
  // the case where reason codes ARE generated.

  it('adds a "Why:" line for safe_to_apply results', async () => {
    const result = await runAgent({
      task: "rename local helper function in one file"
    });

    expect(result.decision.mode).toBe("safe_to_apply");
    expect(result.reasonCodes.length).toBeGreaterThan(0);
    expect(result.explanation).toContain("Why:");
  });

  it("keeps explanation semantically aligned with reason codes", async () => {
    // Phase J.1: switched from "drop billing table" (single-target
    // destructive, now safe_to_apply with 0 reason codes) to a multi-signal
    // task that crosses the score≥71 threshold and produces blocked +
    // populated reason codes.
    const result = await runAgent({
      task: "drop all billing tables and delete every customer record"
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

  // Phase J.1: the previous "preview_only" Why-line test (using auth schema)
  // is removed — schema-touching tasks now produce safe_to_apply with no
  // reason codes (confidence drop from schema penalty doesn't trigger
  // SAFE_HIGH_CONFIDENCE either), which would leave the explanation without
  // a "Why:" line. The remaining safe_to_apply Why-line test below covers
  // the case where reason codes ARE generated.

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
  it("keeps trace reason mapping codes aligned with reasonCodes", async () => {
  const result = await runAgent({
    task: "delete all user sessions"
  });

  expect(result.reasonCodes.length).toBeGreaterThan(0);
  expect(result.trace.reasonMapping.length).toBe(result.reasonCodes.length);
  expect(result.trace.reasonMapping.map((item) => item.code)).toEqual(result.reasonCodes);
});
});
});
it("keeps blocked explanation semantically aligned for destructive mass-scope tasks", async () => {
  const result = await runAgent({
    task: "delete all user sessions"
  });

  expect(result.decision.mode).toBe("blocked");
  expect(result.reasonCodes).toContain("BLOCKED_DESTRUCTIVE_OPERATION");
  expect(result.explanation).toContain("BLOCKED");
  expect(result.explanation.toLowerCase()).toMatch(/destructive|irreversible|high risk|manual review/);
});
  // ---------------------------------------------------------------------------
  // buildExplanation v2 — multi-line integration
  // ---------------------------------------------------------------------------
});
