import { describe, it, expect } from "vitest";
import { resolveInitialTuiMode } from "./initialMode.js";

describe("resolveInitialTuiMode", () => {
  it("maps --permission-mode plan to 'plan'", () => {
    expect(resolveInitialTuiMode("plan")).toBe("plan");
  });

  it("defaults to 'normal' for undefined", () => {
    expect(resolveInitialTuiMode(undefined)).toBe("normal");
  });

  it("defaults to 'normal' for other permission modes", () => {
    expect(resolveInitialTuiMode("default")).toBe("normal");
    expect(resolveInitialTuiMode("acceptEdits")).toBe("normal");
    expect(resolveInitialTuiMode("bypassPermissions")).toBe("normal");
  });
});
