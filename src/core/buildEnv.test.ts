import { describe, expect, it } from "vitest";
import { sanitizeVerificationEnv, strippedEnvKeys } from "./buildEnv.js";

describe("buildEnv", () => {
  it("removes NODE_ENV", () => {
    const env = sanitizeVerificationEnv({
      NODE_ENV: "development",
      PATH: "/usr/bin",
    });

    expect(env.NODE_ENV).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("preserves unrelated environment variables", () => {
    const env = sanitizeVerificationEnv({
      NODE_ENV: "development",
      PATH: "/usr/bin",
      HOME: "/home/bedo",
      ZONE_FOO: "bar",
      npm_lifecycle_event: "serve",
      npm_package_name: "zone-api",
      npm_config_local_prefix: "/home/bedo/zone-api",
      PORT: "3000",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/bedo",
      ZONE_FOO: "bar",
      npm_lifecycle_event: "serve",
      npm_package_name: "zone-api",
      npm_config_local_prefix: "/home/bedo/zone-api",
      PORT: "3000",
    });
  });

  it("reports stripped env keys", () => {
    expect(strippedEnvKeys({ NODE_ENV: "development", PATH: "/usr/bin" })).toEqual([
      "NODE_ENV",
    ]);
    expect(strippedEnvKeys({ PATH: "/usr/bin" })).toEqual([]);
  });

  it("strips BYOK API key env vars", () => {
    const env = sanitizeVerificationEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      OPENAI_API_KEY: "sk-openai-secret",
      GEMINI_API_KEY: "AIzaSy-secret",
      MY_SECRET: "top-secret",
      MY_TOKEN: "tok-abc",
      GITHUB_TOKEN: "ghp-abc",
      GH_TOKEN: "ghp-def",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.MY_SECRET).toBeUndefined();
    expect(env.MY_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strippedEnvKeys reports all stripped keys including secrets", () => {
    const keys = strippedEnvKeys({
      NODE_ENV: "test",
      ANTHROPIC_API_KEY: "x",
      MY_SECRET: "y",
      GITHUB_TOKEN: "z",
      PATH: "/usr/bin",
    });
    expect(keys).toContain("NODE_ENV");
    expect(keys).toContain("ANTHROPIC_API_KEY");
    expect(keys).toContain("MY_SECRET");
    expect(keys).toContain("GITHUB_TOKEN");
    expect(keys).not.toContain("PATH");
    expect(keys).toHaveLength(4);
  });
});
