"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const openaiClient_js_1 = require("./openaiClient.js");
const ORIGINAL_ENV = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ZONE_INFERENCE_MODE: process.env.ZONE_INFERENCE_MODE,
    ZONE_API_BASE_URL: process.env.ZONE_API_BASE_URL,
    VITEST: process.env.VITEST,
};
(0, vitest_1.afterEach)(() => {
    process.env.OPENAI_API_KEY = ORIGINAL_ENV.OPENAI_API_KEY;
    process.env.ZONE_INFERENCE_MODE = ORIGINAL_ENV.ZONE_INFERENCE_MODE;
    process.env.ZONE_API_BASE_URL = ORIGINAL_ENV.ZONE_API_BASE_URL;
    process.env.VITEST = ORIGINAL_ENV.VITEST;
});
(0, vitest_1.describe)("openaiClient inference mode", () => {
    (0, vitest_1.it)("defaults to hosted mode when no local api key is available", () => {
        delete process.env.OPENAI_API_KEY;
        delete process.env.ZONE_INFERENCE_MODE;
        delete process.env.VITEST;
        (0, vitest_1.expect)((0, openaiClient_js_1.getInferenceMode)()).toBe("hosted");
    });
    (0, vitest_1.it)("keeps local mode available for explicit dev configuration", () => {
        delete process.env.OPENAI_API_KEY;
        process.env.ZONE_INFERENCE_MODE = "local";
        (0, vitest_1.expect)((0, openaiClient_js_1.getInferenceMode)()).toBe("local");
    });
    (0, vitest_1.it)("uses local mode automatically in vitest", () => {
        delete process.env.OPENAI_API_KEY;
        delete process.env.ZONE_INFERENCE_MODE;
        process.env.VITEST = "true";
        (0, vitest_1.expect)((0, openaiClient_js_1.getInferenceMode)()).toBe("local");
    });
    (0, vitest_1.it)("normalizes the hosted inference base url", () => {
        process.env.ZONE_API_BASE_URL = "https://zonecli.dev///";
        (0, vitest_1.expect)((0, openaiClient_js_1.getHostedInferenceBaseUrl)()).toBe("https://zonecli.dev");
    });
    (0, vitest_1.it)("keeps the local missing-key error scoped to local inference mode", () => {
        delete process.env.OPENAI_API_KEY;
        (0, vitest_1.expect)(() => (0, openaiClient_js_1.createOpenAIClient)()).toThrow("OPENAI_API_KEY is missing for local inference mode.");
    });
});
//# sourceMappingURL=openaiClient.test.js.map