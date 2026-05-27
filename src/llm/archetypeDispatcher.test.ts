import { describe, expect, it } from "vitest";
import {
  QUESTION_PIPELINE,
  REFACTOR_PIPELINE,
  SIMPLE_ADD_PIPELINE,
  TARGETED_FIX_PIPELINE,
  buildPipelineConfig,
  readArchetypeFlagsFromEnv,
} from "./archetypeDispatcher.js";

describe("readArchetypeFlagsFromEnv", () => {
  it("returns defaults when env is empty (dispatcher/question/investigation/targetedFix/refactor ON, simpleAdd OFF)", () => {
    expect(readArchetypeFlagsFromEnv({})).toEqual({
      dispatcherEnabled: true,
      simpleAddEnabled: false,
      questionEnabled: true,
      investigationEnabled: true,
      targetedFixEnabled: true,
      refactorEnabled: true,
    });
  });

  it("returns dispatcherEnabled true when ZONE_ARCHETYPE_DISPATCHER=1", () => {
    expect(
      readArchetypeFlagsFromEnv({ ZONE_ARCHETYPE_DISPATCHER: "1" }),
    ).toEqual({ dispatcherEnabled: true, simpleAddEnabled: false, questionEnabled: true, investigationEnabled: true, targetedFixEnabled: true, refactorEnabled: true });
  });

  it("returns all-true when dispatcher and simpleAdd flags are '1'", () => {
    expect(
      readArchetypeFlagsFromEnv({
        ZONE_ARCHETYPE_DISPATCHER: "1",
        ZONE_ARCHETYPE_ENABLE_SIMPLE_ADD: "1",
      }),
    ).toEqual({ dispatcherEnabled: true, simpleAddEnabled: true, questionEnabled: true, investigationEnabled: true, targetedFixEnabled: true, refactorEnabled: true });
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

  it("returns null for targeted_fix when targetedFixEnabled is false", () => {
    expect(
      buildPipelineConfig("targeted_fix", {
        dispatcherEnabled: true,
        simpleAddEnabled: true,
        targetedFixEnabled: false,
        refactorEnabled: false,
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

describe("CE.4.1.a: per-archetype iter caps", () => {
  const ALL_ON = {
    dispatcherEnabled: true,
    simpleAddEnabled: true,
    questionEnabled: true,
    investigationEnabled: true,
    targetedFixEnabled: true,
    refactorEnabled: true,
  };

  it("targeted_fix returns TARGETED_FIX_PIPELINE with iterCap:10", () => {
    const result = buildPipelineConfig("targeted_fix", ALL_ON);
    expect(result).toEqual(TARGETED_FIX_PIPELINE);
    expect(result?.iterCap).toBe(10);
  });

  it("refactor returns REFACTOR_PIPELINE with iterCap:12", () => {
    const result = buildPipelineConfig("refactor", ALL_ON);
    expect(result).toEqual(REFACTOR_PIPELINE);
    expect(result?.iterCap).toBe(12);
  });

  it("complex_multi_file returns null (implicit BASE_MAX_ITERATIONS=15)", () => {
    expect(buildPipelineConfig("complex_multi_file", ALL_ON)).toBeNull();
  });

  it("debug returns null (implicit BASE_MAX_ITERATIONS=15)", () => {
    expect(buildPipelineConfig("debug", ALL_ON)).toBeNull();
  });

  it("simple_add returns iterCap:5 (regression guard)", () => {
    expect(buildPipelineConfig("simple_add", ALL_ON)?.iterCap).toBe(5);
    expect(buildPipelineConfig("simple_add", ALL_ON)).toEqual(SIMPLE_ADD_PIPELINE);
  });

  it("question returns iterCap:3 (regression guard)", () => {
    expect(buildPipelineConfig("question", ALL_ON)?.iterCap).toBe(3);
    expect(buildPipelineConfig("question", ALL_ON)).toEqual(QUESTION_PIPELINE);
  });

  it("unknown archetype returns null (BASE_MAX_ITERATIONS fallback unchanged)", () => {
    // Cast to bypass TS narrowing — tests an unrecognised future archetype value
    expect(buildPipelineConfig("unknown_archetype" as "targeted_fix", ALL_ON)).toBeNull();
  });

  it("targeted_fix returns null when targetedFixEnabled:false (flag gate)", () => {
    expect(
      buildPipelineConfig("targeted_fix", { ...ALL_ON, targetedFixEnabled: false }),
    ).toBeNull();
  });
});
