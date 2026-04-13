import { describe, expect, it } from "vitest";
import { resolveBillingAction } from "./resolveBillingAction.js";

describe("resolveBillingAction", () => {
  it("returns CHARGE for Free + Hosted", () => {
    expect(
      resolveBillingAction({
        mode: "hosted",
        hasPaidAccess: false,
      })
    ).toBe("CHARGE");
  });

  it("returns CHARGE for Free + BYOK", () => {
    expect(
      resolveBillingAction({
        mode: "byok",
        hasPaidAccess: false,
      })
    ).toBe("CHARGE");
  });

  it("returns CHARGE for Pro + Hosted", () => {
    expect(
      resolveBillingAction({
        mode: "hosted",
        hasPaidAccess: true,
      })
    ).toBe("CHARGE");
  });

  it("returns FREE for Pro + BYOK", () => {
    expect(
      resolveBillingAction({
        mode: "byok",
        hasPaidAccess: true,
      })
    ).toBe("FREE");
  });
});
