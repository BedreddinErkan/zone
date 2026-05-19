import { describe, expect, it } from "vitest";
import { DEFAULT_AUDIT_MODE, shouldRunAudit } from "./auditMode.js";

describe("shouldRunAudit", () => {
  describe("auditMode=auto", () => {
    it("skips audit for tier=simple", () => {
      const r = shouldRunAudit({ tier: "simple", auditMode: "auto" });
      expect(r.shouldRun).toBe(false);
      expect(r.reason).toContain("auto");
      expect(r.reason).toContain("simple");
    });

    it("runs audit for tier=medium", () => {
      const r = shouldRunAudit({ tier: "medium", auditMode: "auto" });
      expect(r.shouldRun).toBe(true);
      expect(r.reason).toContain("medium");
    });

    it("runs audit for tier=complex", () => {
      const r = shouldRunAudit({ tier: "complex", auditMode: "auto" });
      expect(r.shouldRun).toBe(true);
      expect(r.reason).toContain("complex");
    });
  });

  describe("auditMode=always", () => {
    it.each(["simple", "medium", "complex"] as const)(
      "runs audit for tier=%s",
      (tier) => {
        const r = shouldRunAudit({ tier, auditMode: "always" });
        expect(r.shouldRun).toBe(true);
        expect(r.reason).toContain("always");
      }
    );
  });

  describe("auditMode=on_demand", () => {
    it.each(["simple", "medium", "complex"] as const)(
      "skips audit for tier=%s without explicit request",
      (tier) => {
        const r = shouldRunAudit({ tier, auditMode: "on_demand" });
        expect(r.shouldRun).toBe(false);
        expect(r.reason).toContain("on_demand");
      }
    );

    it("runs audit on explicit request even in on_demand mode", () => {
      const r = shouldRunAudit({ tier: "simple", auditMode: "on_demand", explicitRequest: true });
      expect(r.shouldRun).toBe(true);
      expect(r.reason).toContain("explicit");
    });
  });

  describe("explicit request override", () => {
    it("forces audit in auto mode for simple tier", () => {
      const r = shouldRunAudit({ tier: "simple", auditMode: "auto", explicitRequest: true });
      expect(r.shouldRun).toBe(true);
    });

    it("forces audit in always mode for all tiers (redundant but consistent)", () => {
      const r = shouldRunAudit({ tier: "complex", auditMode: "always", explicitRequest: true });
      expect(r.shouldRun).toBe(true);
    });
  });

  describe("DEFAULT_AUDIT_MODE", () => {
    it("default is auto", () => {
      expect(DEFAULT_AUDIT_MODE).toBe("auto");
    });
  });
});
