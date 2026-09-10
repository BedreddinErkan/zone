import { describe, it, expect } from "vitest";
import { reducer, buildInitialState, buildRunConfig, type RunConfigShape } from "./store-core.js";

function baseState(overrides?: Partial<RunConfigShape>) {
  return buildInitialState({
    model: "test-model",
    capUsd: 10,
    initialConfig: {
      model: "test-model",
      provider: "anthropic",
      dailyCapUsd: 10,
      effort: "medium",
      summaryFormat: "compact",
      memoryEnabled: true,
      webSearchEnabled: true,
      commitOnSuccess: false,
      ...overrides,
    },
  });
}

describe("Phase 6a — CONFIG_PATCHED immutability", () => {
  it("merges patch without mutating original config", () => {
    const s = baseState();
    const originalConfig = s.config;
    const next = reducer(s, { type: "CONFIG_PATCHED", patch: { model: "new-model" } });
    expect(next.config.model).toBe("new-model");
    expect(next.config.provider).toBe("anthropic"); // unchanged
    expect(originalConfig.model).toBe("test-model"); // not mutated
    expect(next.config).not.toBe(originalConfig); // new object
  });

  it("patch with undefined fields still merges (does not delete)", () => {
    const s = baseState({ effort: "high" });
    const next = reducer(s, { type: "CONFIG_PATCHED", patch: { model: "m2" } });
    expect(next.config.effort).toBe("high"); // preserved
  });
});

describe("Phase 6a — next-run semantics", () => {
  it("buildRunConfig returns a fresh copy each time", () => {
    const s = baseState();
    const snap1 = buildRunConfig(s);
    const snap2 = buildRunConfig(s);
    expect(snap1).toEqual(snap2);
    expect(snap1).not.toBe(snap2); // different object references
  });

  it("snapshot taken before patch is unaffected by later patch", () => {
    const s = baseState();
    const snapshotBefore = buildRunConfig(s);
    const patched = reducer(s, { type: "CONFIG_PATCHED", patch: { model: "patched-model" } });
    const snapshotAfter = buildRunConfig(patched);
    expect(snapshotBefore.model).toBe("test-model");
    expect(snapshotAfter.model).toBe("patched-model");
  });
});

describe("Phase 6a — CONFIG_PERSISTED", () => {
  it("is a no-op (informational only)", () => {
    const s = baseState();
    const next = reducer(s, { type: "CONFIG_PERSISTED", path: "/tmp/config.json" });
    expect(next).toBe(s); // same reference — no state change
  });
});

describe("Phase 6a — initialConfig", () => {
  it("buildInitialState uses initialConfig when provided", () => {
    const s = baseState({ model: "custom-model", dailyCapUsd: 25 });
    expect(s.config.model).toBe("custom-model");
    expect(s.config.dailyCapUsd).toBe(25);
  });

  it("buildInitialState creates minimal default when no initialConfig", () => {
    const s = buildInitialState({ model: "m", capUsd: 5 });
    expect(s.config.model).toBe("m");
    expect(s.config.provider).toBe("anthropic");
    expect(s.config.dailyCapUsd).toBe(5);
  });
});
