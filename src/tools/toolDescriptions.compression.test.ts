/**
 * Phase 5 B.4 — description compression regression guard.
 *
 * These assertions prevent re-inflation of the top-5 description offenders.
 * Thresholds are set to compressed targets; tighten them if descriptions shrink further.
 */
import { describe, it, expect } from "vitest";
import { ZONE_TOOLS } from "./toolDefinitions.js";

function descriptionOf(name: string): string {
  const tool = ZONE_TOOLS.find((t) => t.function.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.function.description ?? "";
}

describe("Tool description compression (Phase 5 B.4)", () => {
  it("apply_patch description < 300 chars (behavioral directives preserved)", () => {
    const d = descriptionOf("apply_patch");
    expect(d.length).toBeLessThan(300);
    // Key behavioral directives must survive compression
    expect(d).toMatch(/FIND/);
    expect(d).toMatch(/re-read/);
    expect(d).toMatch(/EXISTING/);
  });

  it("search_in_files description < 200 chars", () => {
    expect(descriptionOf("search_in_files").length).toBeLessThan(200);
  });

  it("Task description < 150 chars", () => {
    expect(descriptionOf("Task").length).toBeLessThan(150);
  });

  it("suggest_scope_change description < 130 chars", () => {
    expect(descriptionOf("suggest_scope_change").length).toBeLessThan(130);
  });

  it("TodoWrite description < 100 chars", () => {
    expect(descriptionOf("TodoWrite").length).toBeLessThan(100);
  });
});
