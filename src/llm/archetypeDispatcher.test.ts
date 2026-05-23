import { describe, expect, it } from "vitest";
import {
  SIMPLE_ADD_PIPELINE,
  buildPipelineConfig,
  readArchetypeFlagsFromEnv,
} from "./archetypeDispatcher.js";

describe("readArchetypeFlagsFromEnv", () => {
  it("returns defaults when env is empty (dispatcher/question/investigation ON, simpleAdd OFF)", () => {
    expect(readArchetypeFlagsFromEnv({})).toEqual({
      dispatcherEnabled: true,
      simpleAddEnabled: false,
      questionEnabled: true,
      investigationEnabled: true,
    });
  });

  it("returns dispatcherEnabled true when ZONE_ARCHETYPE_DISPATCHER=1", () => {
    expect(
      readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_DISPATCHER: "1" }),
    ).toEqual({ dispatcherEnabled: true, simpleAddEnabled: false, questionEnabled: true, investigationEnabled: true });
  });

  it("returns all-true when dispatcher and simpleAdd flags are '1'", () => {
    expect(
      readArchetypeFlagsFromEnv({
        ZONE_ARCHETYPE_DISPATCHER: "1",
        ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD: "1",
      }),
    ).toEqual({ dispatcherEnabled: true, simpleAddEnabled: true, questionEnabled: true, investigationEnabled: true });
  });

  it("accepts any non-'0' value — only '0' disables the flag", () => {
    const flags = readArchetypeFlagsFromEnv({
      ZONE_ARCHETYPE_DISPATCHER: "true",
    });
    expect(flags.dispatcherEnabled).toBe(true);
  });

  it("returns dispatcherEnabled false when ZONE_ARCHETYPE_DISPATCHER=0", () => {
    expect(readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_DISPATCHER: "0" }).dispatcherEnabled).toBe(false);
  });

  it("returns questionEnabled false when ZONE_ARCHETYPE_ENABLE_QUESTION=0", () => {
    expect(readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_ENABLE_QUESTION: "0" }).questionEnabled).toBe(false);
  });

  it("returns investigationEnabled false when ZONE_ARCHETYPE_ENABLE_INVESTIGATION=0", () => {
    expect(readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_ENABLE_INVESTIGATION: "0" }).investigationEnabled).toBe(false);
  });
});

describe("buildPipelineConfig", () => {
  it("returns null when both flags false (master gate)", () => {
    expect(
      buildPipelineConfig("simple_add", {
        dispatcherEnabled: false,
        simpleAddEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns null when master true but simple_add flag false", () => {
    expect(
      buildPipelineConfig("simple_add", {
        dispatcherEnabled: true,
        simpleAddEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns SIMPLE_ADD_PIPELINE shape when both flags true", () => {
    const result = buildPipelineConfig("simple_add", {
      dispatcherEnabled: true,
      simpleAddEnabled: true,
    });
    expect(result).toEqual(SIMPLE_ADD_PIPELINE);
  });

  it("returns a fresh object reference, not the shared constant", () => {
    const result = buildPipelineConfig("simple_add", {
      dispatcherEnabled: true,
      simpleAddEnabled: true,
    });
    expect(result).not.toBe(SIMPLE_ADD_PIPELINE);
  });

  it("returns null for targeted_fix even when both flags true (L5.2+ not wired)", () => {
    expect(
      buildPipelineConfig("targeted_fix", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
      }),
    ).toBeNull();
  });

  it("returns null for complex_multi_file when both flags true", () => {
    expect(
      buildPipelineConfig("complex_multi_file", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
      }),
    ).toBeNull();
  });

  it("returns null for investigation when both flags true", () => {
    expect(
      buildPipelineConfig("investigation", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
      }),
    ).toBeNull();
  });
});
