import { describe, expect, it } from "vitest";
import { resolveBillingAction } from "./resolveBillingAction.js";

describe("resolveBillingAction", () => {
  it("returns FREE for Pro + BYOK even when credits are exhausted", () => {
    expect(
      resolveBillingAction({
        mode: "byok",
        hasPaidAccess: true,
        runsUsedThisMonth: 999,
        credits: 0,
      })
    ).toBe("FREE");
  });

  it("returns FREE for Pro + BYOK when credits remain", () => {
    expect(
      resolveBillingAction({
        mode: "byok",
        hasPaidAccess: true,
        runsUsedThisMonth: 999,
        credits: 10,
      })
    ).toBe("FREE");
  });

  it("returns CHARGE for Free + BYOK when credits remain", () => {
    expect(
      resolveBillingAction({
        mode: "byok",
        hasPaidAccess: false,
        runsUsedThisMonth: 999,
        credits: 10,
      })
    ).toBe("CHARGE");
  });

  it("returns LIMIT_EXCEEDED for Free + BYOK when credits are exhausted", () => {
    expect(
      resolveBillingAction({
        mode: "byok",
        hasPaidAccess: false,
        runsUsedThisMonth: 999,
        credits: 0,
      })
    ).toBe("LIMIT_EXCEEDED");
  });

  it("returns LIMIT_EXCEEDED when hosted credits are exhausted", () => {
    expect(
      resolveBillingAction({
        mode: "hosted",
        hasPaidAccess: true,
        runsUsedThisMonth: 999,
        credits: 0,
      })
    ).toBe("LIMIT_EXCEEDED");
  });

  it("returns CHARGE for hosted runs when credits remain", () => {
    expect(
      resolveBillingAction({
        mode: "hosted",
        hasPaidAccess: true,
        runsUsedThisMonth: 999,
        credits: 10,
      })
    ).toBe("CHARGE");
  });
});
