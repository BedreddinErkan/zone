import { describe, expect, it } from "vitest";
import { resolveBillingAction } from "./resolveBillingAction.js";

describe("resolveBillingAction", () => {
  it("returns FREE for BYOK regardless of limits", () => {
    expect(
      resolveBillingAction({
        mode: "byok",
        hasPaidAccess: false,
        runsUsedThisMonth: 999,
        credits: 0,
      })
    ).toBe("FREE");
  });

  it("returns LIMIT_EXCEEDED when hosted monthly usage reaches credits", () => {
    expect(
      resolveBillingAction({
        mode: "hosted",
        hasPaidAccess: true,
        runsUsedThisMonth: 10,
        credits: 10,
      })
    ).toBe("LIMIT_EXCEEDED");
  });

  it("returns CHARGE for hosted runs below the monthly limit", () => {
    expect(
      resolveBillingAction({
        mode: "hosted",
        hasPaidAccess: true,
        runsUsedThisMonth: 9,
        credits: 10,
      })
    ).toBe("CHARGE");
  });
});
