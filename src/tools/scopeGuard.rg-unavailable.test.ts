/**
 * Isolated mock test for the rg_unavailable degradation branch in maybeExpandScopeForSymbolMatch.
 * Kept in a separate file so the module-level vi.mock does not affect scopeGuard.test.ts,
 * which relies on real rg calls against real temp files.
 */
import { describe, it, expect, vi } from "vitest";
import { maybeExpandScopeForSymbolMatch } from "./scopeGuard.js";

// vi.hoisted keeps the reference available before module evaluation (ESM TDZ constraint).
const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: mockExecFile };
});

describe("maybeExpandScopeForSymbolMatch — rg_unavailable degradation", () => {
  it("returns expanded:false with reason rg_unavailable when rg is not found (ENOENT)", async () => {
    // Simulate "rg not installed": execFile immediately calls the callback with ENOENT.
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], cb: (err: Error | null) => void) => {
        const err = Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
        cb(err);
      }
    );

    const plan = {
      objective: "rename cumulativeTokens across codebase",
      steps: [{ title: "rename", description: "apply", filesLikely: ["src/a.ts"] }],
      riskHints: [],
      scopeSummary: "",
    };

    const result = await maybeExpandScopeForSymbolMatch(
      plan, "src/b.ts", "/repo", "refactor"
    );

    expect(result.expanded).toBe(false);
    expect(result.reason).toBe("rg_unavailable");
  });
});
