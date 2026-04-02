import { describe, expect, it } from "vitest";
import { isIntentAllowed } from "./isIntentAllowed.js";

describe("isIntentAllowed", () => {
  it("rejects all intents for blocked strategy", () => {
    expect(isIntentAllowed("rename_symbol", "blocked")).toBe(false);
    expect(isIntentAllowed("update_import", "blocked")).toBe(false);
    expect(isIntentAllowed("add_comment", "blocked")).toBe(false);
    expect(isIntentAllowed("safe_replace", "blocked")).toBe(false);
    expect(isIntentAllowed("unknown", "blocked")).toBe(false);
  });

  it("allows only restricted-safe intents for restricted strategy", () => {
    expect(isIntentAllowed("rename_symbol", "restricted")).toBe(true);
    expect(isIntentAllowed("add_comment", "restricted")).toBe(true);
    expect(isIntentAllowed("safe_replace", "restricted")).toBe(true);

    expect(isIntentAllowed("update_import", "restricted")).toBe(false);
    expect(isIntentAllowed("unknown", "restricted")).toBe(false);
  });

  it("allows all supported intents except unknown for safe strategy", () => {
    expect(isIntentAllowed("rename_symbol", "safe")).toBe(true);
    expect(isIntentAllowed("update_import", "safe")).toBe(true);
    expect(isIntentAllowed("add_comment", "safe")).toBe(true);
    expect(isIntentAllowed("safe_replace", "safe")).toBe(true);

    expect(isIntentAllowed("unknown", "safe")).toBe(false);
  });

  it("always rejects unknown intent regardless of strategy", () => {
    expect(isIntentAllowed("unknown", "blocked")).toBe(false);
    expect(isIntentAllowed("unknown", "restricted")).toBe(false);
    expect(isIntentAllowed("unknown", "safe")).toBe(false);
  });
});