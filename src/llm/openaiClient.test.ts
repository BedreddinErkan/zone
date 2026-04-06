import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenAIClient,
  getHostedInferenceBaseUrl,
  getInferenceMode,
} from "./openaiClient.js";

const ORIGINAL_ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ZONE_INFERENCE_MODE: process.env.ZONE_INFERENCE_MODE,
  ZONE_API_BASE_URL: process.env.ZONE_API_BASE_URL,
  VITEST: process.env.VITEST,
};

afterEach(() => {
  process.env.OPENAI_API_KEY = ORIGINAL_ENV.OPENAI_API_KEY;
  process.env.ZONE_INFERENCE_MODE = ORIGINAL_ENV.ZONE_INFERENCE_MODE;
  process.env.ZONE_API_BASE_URL = ORIGINAL_ENV.ZONE_API_BASE_URL;
  process.env.VITEST = ORIGINAL_ENV.VITEST;
});

describe("openaiClient inference mode", () => {
  it("defaults to hosted mode when no local api key is available", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ZONE_INFERENCE_MODE;
    delete process.env.VITEST;

    expect(getInferenceMode()).toBe("hosted");
  });

  it("keeps local mode available for explicit dev configuration", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ZONE_INFERENCE_MODE = "local";

    expect(getInferenceMode()).toBe("local");
  });

  it("uses local mode automatically in vitest", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ZONE_INFERENCE_MODE;
    process.env.VITEST = "true";

    expect(getInferenceMode()).toBe("local");
  });

  it("normalizes the hosted inference base url", () => {
    process.env.ZONE_API_BASE_URL = "https://zonecli.dev///";

    expect(getHostedInferenceBaseUrl()).toBe("https://zonecli.dev");
  });

  it("keeps the local missing-key error scoped to local inference mode", () => {
    delete process.env.OPENAI_API_KEY;

    expect(() => createOpenAIClient()).toThrow(
      "OPENAI_API_KEY is missing for local inference mode."
    );
  });
});
