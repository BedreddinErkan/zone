import { describe, expect, it } from "vitest";
import { getRequestContext, withRequestContext } from "./openaiContext.js";

describe("openaiContext", () => {
  it("scopes subagent context to the callback", async () => {
    expect(getRequestContext()).toBeUndefined();

    await withRequestContext({ subagentId: "abc" }, async () => {
      expect(getRequestContext()?.subagentId).toBe("abc");
    });

    expect(getRequestContext()).toBeUndefined();
  });

  it("merges nested request contexts and restores the outer scope", async () => {
    await withRequestContext({ userApiKey: "key-1", runId: "run-1" }, async () => {
      expect(getRequestContext()).toMatchObject({
        userApiKey: "key-1",
        runId: "run-1",
      });

      await withRequestContext({ subagentId: "sub-1", subagentType: "worker" }, async () => {
        expect(getRequestContext()).toMatchObject({
          userApiKey: "key-1",
          runId: "run-1",
          subagentId: "sub-1",
          subagentType: "worker",
        });
      });

      expect(getRequestContext()).toMatchObject({
        userApiKey: "key-1",
        runId: "run-1",
      });
      expect(getRequestContext()?.subagentId).toBeUndefined();
    });

    expect(getRequestContext()).toBeUndefined();
  });
});
