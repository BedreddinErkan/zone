import { describe, expect, it } from "vitest";
import { resolveBillingAction } from "./resolveBillingAction.js";

describe("resolveBillingAction", () => {
  describe("hosted mode", () => {
    it("returns CHARGE for the first run", () => {
      expect(
        resolveBillingAction({
          mode: "hosted",
          conversation: {
            chargedRunCount: 0,
            hasFreeRefinementBeenUsed: false,
          },
        })
      ).toBe("CHARGE");
    });

    it("returns FREE for the second run when free refinement is unused", () => {
      expect(
        resolveBillingAction({
          mode: "hosted",
          conversation: {
            chargedRunCount: 1,
            hasFreeRefinementBeenUsed: false,
          },
        })
      ).toBe("FREE");
    });

    it("returns CHARGE for later runs after free refinement has been used", () => {
      expect(
        resolveBillingAction({
          mode: "hosted",
          conversation: {
            chargedRunCount: 2,
            hasFreeRefinementBeenUsed: true,
          },
        })
      ).toBe("CHARGE");
    });
  });

  describe("byok mode", () => {
    it("returns FREE for the first run", () => {
      expect(
        resolveBillingAction({
          mode: "byok",
          conversation: {
            chargedRunCount: 0,
            hasFreeRefinementBeenUsed: false,
          },
        })
      ).toBe("FREE");
    });

    it("returns FREE for the second run", () => {
      expect(
        resolveBillingAction({
          mode: "byok",
          conversation: {
            chargedRunCount: 1,
            hasFreeRefinementBeenUsed: false,
          },
        })
      ).toBe("FREE");
    });

    it("returns FREE for later runs", () => {
      expect(
        resolveBillingAction({
          mode: "byok",
          conversation: {
            chargedRunCount: 3,
            hasFreeRefinementBeenUsed: true,
          },
        })
      ).toBe("FREE");
    });
  });
});
