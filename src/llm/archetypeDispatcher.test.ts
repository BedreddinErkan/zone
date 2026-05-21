import { describe, expect, it } from "vitest";
import {
  SIMPLE_ADD_PIPELINE,
  TARGETED_FIX_PIPELINE,
  buildPipelineConfig,
  readArchetypeFlagsFromEnv,
} from "./archetypeDispatcher.js";

describe("readArchetypeFlagsFromEnv", () => {
  it("returns all false when env is empty", () => {
    expect(readArchetypeFlagsFromEnv({})).toEqual({
      dispatcherEnabled: false,
      simpleAddEnabled: false,
      targetedFixEnabled: false,
    });
  });

  it("returns dispatcherEnabled true when ZONE_ARCHETYPE_DISPATCHER=1", () => {
    expect(
      readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_DISPATCHER: "1" }),
    ).toEqual({ dispatcherEnabled: true, simpleAddEnabled: false, targetedFixEnabled: false });
  });

  it("returns both true when both flags are '1'", () => {
    expect(
      readArchetypeFlagsFromEnv({
        ZONE_ARCHETYPE_DISPATCHER: "1",
        ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD: "1",
      }),
    ).toEqual({ dispatcherEnabled: true, simpleAddEnabled: true, targetedFixEnabled: false });
  });

  it("rejects 'true' literal — only '1' enables the flag", () => {
    const flags = readArchetypeFlagsFromEnv({
      ZONE_ARCHETYPE_DISPATCHER: "true",
    });
    expect(flags.dispatcherEnabled).toBe(false);
  });
});

describe("buildPipelineConfig", () => {
  it("returns null when both flags false (master gate)", () => {
    expect(
      buildPipelineConfig("simple_add", {
        dispatcherEnabled: false,
        simpleAddEnabled: false,
        targetedFixEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns null when master true but simple_add flag false", () => {
    expect(
      buildPipelineConfig("simple_add", {
        dispatcherEnabled: true,
        simpleAddEnabled: false,
        targetedFixEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns SIMPLE_ADD_PIPELINE shape when both flags true", () => {
    const result = buildPipelineConfig("simple_add", {
      dispatcherEnabled: true,
      simpleAddEnabled: true,
      targetedFixEnabled: false,
    });
    expect(result).toEqual(SIMPLE_ADD_PIPELINE);
  });

  it("returns a fresh object reference, not the shared constant", () => {
    const result = buildPipelineConfig("simple_add", {
      dispatcherEnabled: true,
      simpleAddEnabled: true,
      targetedFixEnabled: false,
    });
    expect(result).not.toBe(SIMPLE_ADD_PIPELINE);
  });

  it("returns null for targeted_fix when targetedFixEnabled flag off", () => {
    expect(
      buildPipelineConfig("targeted_fix", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
        targetedFixEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns null for complex_multi_file when both flags true", () => {
    expect(
      buildPipelineConfig("complex_multi_file", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
        targetedFixEnabled: false,
      }),
    ).toBeNull();
  });

  it("returns null for investigation when both flags true", () => {
    expect(
      buildPipelineConfig("investigation", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
        targetedFixEnabled: false,
      }),
    ).toBeNull();
  });

  it("L5.2: returns TARGETED_FIX_PIPELINE shape when dispatcher and targetedFix flags true", () => {
    const result = buildPipelineConfig("targeted_fix", {
      dispatcherEnabled: true,
      simpleAddEnabled: false,
      targetedFixEnabled: true,
    });
    expect(result).toEqual(TARGETED_FIX_PIPELINE);
  });

  it("L5.2: returns null for targeted_fix when targetedFixEnabled is false", () => {
    expect(
      buildPipelineConfig("targeted_fix", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
        targetedFixEnabled: false,
      }),
    ).toBeNull();
  });

  it("L5.2: returns fresh object reference for TARGETED_FIX_PIPELINE", () => {
    const result = buildPipelineConfig("targeted_fix", {
      dispatcherEnabled: true,
      simpleAddEnabled: false,
      targetedFixEnabled: true,
    });
    expect(result).not.toBe(TARGETED_FIX_PIPELINE);
  });

  it("L5.2: refactor archetype with targetedFixEnabled=true returns null", () => {
    expect(
      buildPipelineConfig("refactor", {
        dispatcherEnabled: true,
        simpleAddEnabled: false,
        targetedFixEnabled: true,
      }),
    ).toBeNull();
  });

  it("L5.2: simple_add still routes correctly when both pipeline flags are true", () => {
    const result = buildPipelineConfig("simple_add", {
      dispatcherEnabled: true,
      simpleAddEnabled: true,
      targetedFixEnabled: true,
    });
    expect(result).toEqual(SIMPLE_ADD_PIPELINE);
  });
});
