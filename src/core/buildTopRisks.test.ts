import { describe, it, expect } from "vitest";
import { buildTopRisks } from "./runAgent.js";

// ---------------------------------------------------------------------------
// buildTopRisks — signal-specific, actionable reasons
// ---------------------------------------------------------------------------

describe("buildTopRisks — destructive signal", () => {
  it("returns a high-severity risk with actionable reason", () => {
    const risks = buildTopRisks(75, ["destructive"]);

    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      title: "Potentially destructive change",
      severity: "high",
      reason: "Task contains destructive keywords that may cause irreversible data loss.",
    });
  });

  it("reason does NOT contain the score", () => {
    const risks = buildTopRisks(99, ["destructive"]);
    expect(risks[0]?.reason).not.toContain("99");
    expect(risks[0]?.reason).not.toMatch(/Risk score/i);
  });
});

describe("buildTopRisks — schema signal", () => {
  it("returns a medium-severity risk with actionable reason", () => {
    const risks = buildTopRisks(25, ["schema"]);

    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      title: "Schema-sensitive change",
      severity: "medium",
      reason: "Schema modifications can break existing data contracts or migrations.",
    });
  });
});

describe("buildTopRisks — critical_domain signal", () => {
  it("returns a medium-severity risk with actionable reason", () => {
    const risks = buildTopRisks(40, ["critical_domain"]);

    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      title: "Critical domain surface",
      severity: "medium",
      reason: "Touches auth, billing, or production — elevated impact if change is incorrect.",
    });
  });
});

describe("buildTopRisks — mass_scope signal", () => {
  it("returns a high-severity risk with actionable reason", () => {
    const risks = buildTopRisks(60, ["mass_scope"]);

    expect(risks).toHaveLength(1);
    expect(risks[0]).toMatchObject({
      title: "Mass-scope operation",
      severity: "high",
      reason: "Task targets all records or the entire dataset — bulk operations are irreversible.",
    });
  });

  it("reason does NOT contain the score", () => {
    const risks = buildTopRisks(88, ["mass_scope"]);
    expect(risks[0]?.reason).not.toContain("88");
    expect(risks[0]?.reason).not.toMatch(/Risk score/i);
  });
});

describe("buildTopRisks — multiple signals", () => {
  it("returns one risk per active signal, in signal priority order", () => {
    const risks = buildTopRisks(75, ["destructive", "schema"]);

    expect(risks).toHaveLength(2);
    expect(risks[0]?.title).toBe("Potentially destructive change");
    expect(risks[1]?.title).toBe("Schema-sensitive change");
  });

  it("returns all three risks when all non-low signals are present", () => {
    const risks = buildTopRisks(80, ["destructive", "schema", "critical_domain"]);

    expect(risks).toHaveLength(3);
    expect(risks.map((r) => r.severity)).toEqual(["high", "medium", "medium"]);
  });

  it("includes mass_scope in signal priority order", () => {
    const risks = buildTopRisks(90, [
      "destructive",
      "schema",
      "critical_domain",
      "mass_scope",
    ]);

    expect(risks).toHaveLength(4);
    expect(risks.map((r) => r.title)).toEqual([
      "Potentially destructive change",
      "Schema-sensitive change",
      "Critical domain surface",
      "Mass-scope operation",
    ]);
    expect(risks.map((r) => r.severity)).toEqual([
      "high",
      "medium",
      "medium",
      "high",
    ]);
  });
});

describe("buildTopRisks — low_risk signal", () => {
  it("returns no risks for low_risk-only signal", () => {
    const risks = buildTopRisks(5, ["low_risk"]);
    expect(risks).toHaveLength(0);
  });

  it("returns no risks for empty signals", () => {
    const risks = buildTopRisks(0, []);
    expect(risks).toHaveLength(0);
  });
});