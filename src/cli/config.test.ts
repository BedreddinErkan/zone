import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadCliConfig, validateCliConfig } from "./config.js";
import { readDailyUsdCapOverride } from "../visual/tierSettings.js";

// We inject the configFile directly via the optional _configFile param to
// avoid mocking the filesystem; env var tests use vi.stubEnv for isolation.

vi.mock("../visual/tierSettings.js", () => ({
  readDailyUsdCapOverride: vi.fn(),
}));

describe("loadCliConfig — defaults", () => {
  it("applies built-in defaults when nothing else is set", () => {
    const cfg = loadCliConfig({}, {});
    expect(cfg.model).toBe("claude-sonnet-4-6");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.dailyUsdCap).toBe(10);
    expect(cfg.autoApprove).toBe(false);
    expect(cfg.noRevision).toBe(false);
    expect(cfg.verbose).toBe(false);
    expect(cfg.quiet).toBe(false);
    expect(cfg.noColor).toBe(false);
    expect(cfg.repoPath).toBe(process.cwd());
  });

  it("forceTier is undefined when not set", () => {
    const cfg = loadCliConfig({}, {});
    expect(cfg.forceTier).toBeUndefined();
  });
});

describe("loadCliConfig — flag precedence", () => {
  it("--model flag overrides env + config file", () => {
    vi.stubEnv("ZONE_MODEL", "gpt-4o");
    const cfg = loadCliConfig({ model: "claude-opus-4-7" }, { defaultModel: "gpt-3.5-turbo" });
    expect(cfg.model).toBe("claude-opus-4-7");
  });

  it("--force-tier=simple accepted", () => {
    const cfg = loadCliConfig({ forceTier: "simple" }, {});
    expect(cfg.forceTier).toBe("simple");
  });

  it("--force-tier=medium accepted", () => {
    const cfg = loadCliConfig({ forceTier: "medium" }, {});
    expect(cfg.forceTier).toBe("medium");
  });

  it("--force-tier=complex accepted", () => {
    const cfg = loadCliConfig({ forceTier: "complex" }, {});
    expect(cfg.forceTier).toBe("complex");
  });

  it("--force-tier=invalid → undefined", () => {
    const cfg = loadCliConfig({ forceTier: "ultra" }, {});
    expect(cfg.forceTier).toBeUndefined();
  });

  it("--yes sets autoApprove=true", () => {
    const cfg = loadCliConfig({ yes: true }, {});
    expect(cfg.autoApprove).toBe(true);
  });

  it("--no-revision sets noRevision=true", () => {
    const cfg = loadCliConfig({ noRevision: true }, {});
    expect(cfg.noRevision).toBe(true);
  });

  it("--verbose sets verbose=true", () => {
    const cfg = loadCliConfig({ verbose: true }, {});
    expect(cfg.verbose).toBe(true);
  });

  it("--no-color sets noColor=true", () => {
    const cfg = loadCliConfig({ noColor: true }, {});
    expect(cfg.noColor).toBe(true);
  });

  it("--repo overrides cwd", () => {
    const cfg = loadCliConfig({ repo: "/tmp/myrepo" }, {});
    expect(cfg.repoPath).toBe("/tmp/myrepo");
  });
});

describe("loadCliConfig — env var precedence", () => {
  it("ZONE_MODEL env overrides config file, loses to flag", () => {
    vi.stubEnv("ZONE_MODEL", "gpt-4o");
    const cfg = loadCliConfig({}, { defaultModel: "gpt-3.5-turbo" });
    expect(cfg.model).toBe("gpt-4o");
  });

  it("ANTHROPIC_API_KEY env applied as anthropicApiKey", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    const cfg = loadCliConfig({}, {});
    expect(cfg.anthropicApiKey).toBe("sk-ant-test");
  });

  it("OPENAI_API_KEY env applied as openaiApiKey", () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-openai-test");
    const cfg = loadCliConfig({}, {});
    expect(cfg.openaiApiKey).toBe("sk-openai-test");
  });

  it("ZONE_DAILY_USD_CAP env overrides default", () => {
    vi.stubEnv("ZONE_DAILY_USD_CAP", "25");
    const cfg = loadCliConfig({}, {});
    expect(cfg.dailyUsdCap).toBe(25);
  });

  it("ZONE_FORCE_TIER=medium applied", () => {
    vi.stubEnv("ZONE_FORCE_TIER", "medium");
    const cfg = loadCliConfig({}, {});
    expect(cfg.forceTier).toBe("medium");
  });

  it("ZONE_VERBOSE_LOGS=1 sets verbose=true", () => {
    vi.stubEnv("ZONE_VERBOSE_LOGS", "1");
    const cfg = loadCliConfig({}, {});
    expect(cfg.verbose).toBe(true);
  });

  it("NO_COLOR=1 sets noColor=true", () => {
    vi.stubEnv("NO_COLOR", "1");
    const cfg = loadCliConfig({}, {});
    expect(cfg.noColor).toBe(true);
  });
});

describe("loadCliConfig — config file precedence", () => {
  it("config file defaultModel used when no env/flag", () => {
    // Ensure no env override
    vi.stubEnv("ZONE_MODEL", "");
    const cfg = loadCliConfig({}, { defaultModel: "claude-haiku-4-5-20251001" });
    expect(cfg.model).toBe("claude-haiku-4-5-20251001");
  });

  it("config file anthropicApiKey used when ANTHROPIC_API_KEY not set", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const cfg = loadCliConfig({}, { anthropicApiKey: "sk-ant-file" });
    expect(cfg.anthropicApiKey).toBe("sk-ant-file");
  });

  it("config file dailyUsdCap used when env not set", () => {
    vi.stubEnv("ZONE_DAILY_USD_CAP", "");
    const cfg = loadCliConfig({}, { dailyUsdCap: 5 });
    expect(cfg.dailyUsdCap).toBe(5);
  });

  it("openai provider set from config file", () => {
    const cfg = loadCliConfig({}, { defaultProvider: "openai" });
    expect(cfg.provider).toBe("openai");
  });

  it("unknown provider string → falls back to anthropic", () => {
    const cfg = loadCliConfig({}, { defaultProvider: "gemini" });
    expect(cfg.provider).toBe("anthropic");
  });
});

describe("validateCliConfig", () => {
  it("throws when anthropic provider and no anthropicApiKey", () => {
    expect(() =>
      validateCliConfig({
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
        dailyUsdCap: 10,
        repoPath: "/tmp",
        autoApprove: false,
        noRevision: false,
        verbose: false,
        quiet: false,
        noColor: false,
      })
    ).toThrow("ANTHROPIC_API_KEY");
  });

  it("throws when openai provider and no openaiApiKey", () => {
    expect(() =>
      validateCliConfig({
        model: "gpt-4o",
        provider: "openai",
        anthropicApiKey: undefined,
        openaiApiKey: undefined,
        dailyUsdCap: 10,
        repoPath: "/tmp",
        autoApprove: false,
        noRevision: false,
        verbose: false,
        quiet: false,
        noColor: false,
      })
    ).toThrow("OPENAI_API_KEY");
  });

  it("does not throw when anthropicApiKey is present", () => {
    expect(() =>
      validateCliConfig({
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        anthropicApiKey: "sk-ant-abc",
        openaiApiKey: undefined,
        dailyUsdCap: 10,
        repoPath: "/tmp",
        autoApprove: false,
        noRevision: false,
        verbose: false,
        quiet: false,
        noColor: false,
      })
    ).not.toThrow();
  });
});

describe("loadCliConfig — tier-limits override (TUI.7.I Phase A)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("T1: readDailyUsdCapOverride value 25 used when env not set", () => {
    vi.mocked(readDailyUsdCapOverride).mockReturnValue(25);
    const cfg = loadCliConfig({}, {});
    expect(cfg.dailyUsdCap).toBe(25);
  });

  it("T2: ZONE_DAILY_USD_CAP env wins over tier-limits override", () => {
    vi.stubEnv("ZONE_DAILY_USD_CAP", "30");
    vi.mocked(readDailyUsdCapOverride).mockReturnValue(25);
    const cfg = loadCliConfig({}, {});
    expect(cfg.dailyUsdCap).toBe(30);
  });
});
