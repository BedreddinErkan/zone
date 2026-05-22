/**
 * Phase 6.B.2 — undici Agent dispatcher config assertion.
 *
 * Confirms that the module-level sweepDispatcher is created with bodyTimeout:0
 * and headersTimeout:0 so Node 26's passive 5-min body timeout is bypassed.
 */
import { describe, it, expect, vi } from "vitest";
import { Agent } from "undici";

vi.mock("undici", () => ({
  Agent: vi.fn().mockImplementation(() => ({})),
}));

describe("sweep dispatcher config (Phase 6.B.2)", () => {
  it("creates Agent with bodyTimeout:0 and headersTimeout:0", async () => {
    await import("./sweep.js");
    expect(Agent).toHaveBeenCalledWith(
      expect.objectContaining({ bodyTimeout: 0, headersTimeout: 0 })
    );
  });
});
