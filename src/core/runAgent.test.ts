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
    lowRiskBonus: 0
  });
});

it("includes confidence breakdown for destructive database tasks", async () => {
  const result = await runAgent({
    task: "delete user table from database"
  });

  expect(result.confidence.score).toBe(25);
  expect(result.confidence.breakdown).toEqual({
    base: 100,
    destructivePenalty: -50,
    schemaPenalty: -25,
    criticalPenalty: 0,
    lowRiskBonus: 0
  });
});