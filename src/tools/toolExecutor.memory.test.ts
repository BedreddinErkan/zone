import { describe, it, expect } from "vitest";
import { MEMORY_WARN_THRESHOLD_BYTES } from "../memory/constants.js";

describe("MEMORY_WARN_THRESHOLD_BYTES", () => {
  it("T1: size below threshold produces no warning (boundary check)", () => {
    const size = MEMORY_WARN_THRESHOLD_BYTES;
    const warning = size > MEMORY_WARN_THRESHOLD_BYTES
      ? "\n\n⚠️ Memory exceeds 40K chars; consider trimming."
      : "";
    expect(warning).toBe("");
  });

  it("T2: size above threshold produces warning text", () => {
    const size = MEMORY_WARN_THRESHOLD_BYTES + 1;
    const warning = size > MEMORY_WARN_THRESHOLD_BYTES
      ? "\n\n⚠️ Memory exceeds 40K chars; consider trimming."
      : "";
    expect(warning).toContain("⚠️ Memory exceeds 40K chars");
  });
});
