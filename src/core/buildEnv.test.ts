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
});
