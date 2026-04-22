import { describe, expect, it } from "vitest";
import { resolveBillingAction } from "./resolveBillingAction.js";

describe("resolveBillingAction", () => {
  it("returns LIMIT_EXCEEDED when hosted credits are exhausted", () => {
    expect(
      resolveBillingAction({
        mode: "hosted",
        hasPaidAccess: true,
        runsUsedThisMonth: 999,
        credits: 0,
        tokenCreditsUsed: 500000,
        tokenCreditsLimit: 500000,
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
        tokenCreditsUsed: 123,
        tokenCreditsLimit: 500000,
      })
    ).toBe("CHARGE");
  });
});
