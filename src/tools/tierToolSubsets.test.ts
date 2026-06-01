import { describe, it, expect } from "vitest";
import { tierToolFilter, SIMPLE_TIER_TOOLS, MEDIUM_TIER_TOOLS } from "./tierToolSubsets.js";

describe("tierToolFilter", () => {
  it("simple tier: filter contains the core tools including multi_edit", () => {
    const filter = tierToolFilter("simple");
    expect(filter).toBeDefined();
    expect(filter!.allowToolNames).toEqual(SIMPLE_TIER_TOOLS);
    expect([...SIMPLE_TIER_TOOLS]).toEqual(
      expect.arrayContaining(["read_file", "write_file", "apply_patch", "multi_edit", "run_command"])
    );
    expect(SIMPLE_TIER_TOOLS.size).toBe(5);
  });

  it("medium tier: filter contains the expected tools including multi_edit", () => {
    const filter = tierToolFilter("medium");
    expect(filter).toBeDefined();
    expect(filter!.allowToolNames).toEqual(MEDIUM_TIER_TOOLS);
    expect([...MEDIUM_TIER_TOOLS]).toEqual(
      expect.arrayContaining([
        "read_file", "write_file", "apply_patch", "multi_edit", "run_command",
        "search_in_files", "list_files", "find_references", "TodoWrite",
      ])
    );
    expect(MEDIUM_TIER_TOOLS.size).toBe(9);
  });

  it("complex tier: returns undefined (no restriction)", () => {
    const filter = tierToolFilter("complex");
    expect(filter).toBeUndefined();
  });
});
