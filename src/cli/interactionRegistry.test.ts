import { describe, it, expect, beforeEach } from "vitest";
import * as registry from "./interactionRegistry.js";

beforeEach(() => {
  registry.abortAll("test cleanup");
});

describe("interactionRegistry — request/resolve round-trip", () => {
  it("resolves a command_approval", () => {
    let resolved = false;
    registry.request("command_approval", "a1", {
      resolve: () => { resolved = true; },
    });
    expect(registry.pendingCount("command_approval")).toBe(1);
    const ok = registry.resolve("command_approval", "a1", true);
    expect(ok).toBe(true);
    expect(resolved).toBe(true);
    expect(registry.pendingCount("command_approval")).toBe(0);
  });

  it("resolves an edit_approval", () => {
    let result: any = null;
    registry.request("edit_approval", "e1", {
      resolve: (v: any) => { result = v; },
    });
    registry.resolve("edit_approval", "e1", true);
    expect(result).toBe(true);
  });

  it("resolves a question", () => {
    let result: any = null;
    registry.request("question", "q1", {
      runId: "r1",
      resolve: (v: any) => { result = v; },
    });
    registry.resolve("question", "q1", { answer: "yes", disposition: "answered" });
    expect(result).toEqual({ answer: "yes", disposition: "answered" });
  });

  it("resolve returns false for unknown id", () => {
    expect(registry.resolve("command_approval", "nonexistent", true)).toBe(false);
  });
});

describe("interactionRegistry — abort", () => {
  it("abort rejects a pending promise", () => {
    let resolved = false;
    registry.request("command_approval", "a1", {
      resolve: () => { resolved = true; },
    });
    registry.abort("command_approval", "a1");
    expect(resolved).toBe(true);
    expect(registry.pendingCount()).toBe(0);
  });

  it("abortAll rejects all pending across kinds", () => {
    let count = 0;
    registry.request("command_approval", "a1", { resolve: () => count++ });
    registry.request("edit_approval", "e1", { resolve: () => count++ });
    registry.request("question", "q1", { resolve: () => count++ });
    registry.request("plan_ready", "p1", { resolve: () => count++ });
    expect(registry.pendingCount()).toBe(4);
    const rejected = registry.abortAll("test");
    expect(rejected).toBe(4);
    expect(count).toBe(4);
    expect(registry.pendingCount()).toBe(0);
  });
});

describe("interactionRegistry — pendingCount", () => {
  it("counts by kind", () => {
    registry.request("command_approval", "a1", { resolve: () => {} });
    registry.request("command_approval", "a2", { resolve: () => {} });
    registry.request("edit_approval", "e1", { resolve: () => {} });
    expect(registry.pendingCount("command_approval")).toBe(2);
    expect(registry.pendingCount("edit_approval")).toBe(1);
    expect(registry.pendingCount()).toBe(3);
  });
});

describe("interactionRegistry — rejectByKindAndRun", () => {
  it("rejects only matching kind+runId", () => {
    let resolved: string[] = [];
    registry.request("command_approval", "a1", { runId: "r1", resolve: () => resolved.push("a1") });
    registry.request("command_approval", "a2", { runId: "r2", resolve: () => resolved.push("a2") });
    registry.request("edit_approval", "e1", { runId: "r1", resolve: () => resolved.push("e1") });
    const n = registry.rejectByKindAndRun("command_approval", "r1");
    expect(n).toBe(1);
    expect(resolved).toEqual(["a1"]);
    expect(registry.pendingCount()).toBe(2); // a2 + e1 remain
  });
});

describe("interactionRegistry — abort signal wiring", () => {
  it("abort signal resolves the pending promise", async () => {
    const ac = new AbortController();
    let resolved = false;
    registry.request("command_approval", "a1", {
      resolve: () => { resolved = true; },
      abortSignal: ac.signal,
    });
    expect(registry.pendingCount()).toBe(1);
    ac.abort();
    // The abort listener fires synchronously
    expect(resolved).toBe(true);
    expect(registry.pendingCount()).toBe(0);
  });

  it("already-aborted signal prevents registration", () => {
    const ac = new AbortController();
    ac.abort();
    let resolved = false;
    registry.request("command_approval", "a1", {
      resolve: () => { resolved = true; },
      abortSignal: ac.signal,
    });
    // Should have resolved immediately without registering
    expect(resolved).toBe(true);
    expect(registry.pendingCount()).toBe(0);
  });
});

describe("interactionRegistry — timeout", () => {
  it("timeout resolves with timeoutResult", async () => {
    let result: any = null;
    registry.request("command_approval", "a1", {
      resolve: (v: any) => { result = v; },
      timeoutMs: 50,
      timeoutResult: "timed_out",
    });
    expect(registry.pendingCount()).toBe(1);
    await new Promise(r => setTimeout(r, 100));
    expect(result).toBe("timed_out");
    expect(registry.pendingCount()).toBe(0);
  });
});
