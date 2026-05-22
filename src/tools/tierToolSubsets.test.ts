import { describe, it, expect } from "vitest";
import { tierToolFilter, SIMPLE_TIER_TOOLS, MEDIUM_TIER_TOOLS } from "./tierToolSubsets.js";

describe("tierToolFilter", () => {
  it("simple tier: filter contains exactly the 4 core tools", () => {
    const filter = tierToolFilter("simple");
    expect(filter).toBeDefined();
    expect(filter!.allowToolNames).toEqual(SIMPLE_TIER_TOOLS);
    expect([...SIMPLE_TIER_TOOLS]).toEqual(
      expect.arrayContaining(["read_file", "write_file", "apply_patch", "run_command"])
    );
    expect(SIMPLE_TIER_TOOLS.size).toBe(4);
  });

  it("medium tier: filter contains the 8 expected tools", () => {
    const filter = tierToolFilter("medium");
    expect(filter).toBeDefined();
    expect(filter!.allowToolNames).toEqual(MEDIUM_TIER_TOOLS);
    expect([...MEDIUM_TIER_TOOLS]).toEqual(
      expect.arrayContaining([
        "read_file", "write_file", "apply_patch", "run_command",
        "search_in_files", "list_files", "find_references", "TodoWrite",
      ])
    );
    expect(MEDIUM_TIER_TOOLS.size).toBe(8);
  });

  it("complex tier: returns undefined (no restriction)", () => {
    const filter = tierToolFilter("complex");
    expect(filter).toBeUndefined();
  });
});
