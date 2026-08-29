import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { loadDiskMcp, mcpConfigHash, buildMcpBaseEnv, expandMcpEnv } from "./diskMcp.js";

const VALID_MCP_JSON = JSON.stringify({
  version: 1,
  mcpServers: {
    filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    github: { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" } },
  },
});

describe("diskMcp — loadDiskMcp", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "zone-mcp-"));
    await mkdir(join(tmp, ".zone"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // T-MCPCFG-MISSING
  it("returns null when mcp.json is absent", async () => {
    expect(await loadDiskMcp(tmp)).toBeNull();
  });

  // T-MCPCFG-VALID
  it("parses valid mcp.json and attaches _rawBytes", async () => {
    await writeFile(join(tmp, ".zone", "mcp.json"), VALID_MCP_JSON);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    expect(cfg!.version).toBe(1);
    expect(Object.keys(cfg!.mcpServers)).toEqual(["filesystem", "github"]);
    expect(cfg!.mcpServers.filesystem.command).toBe("npx");
    expect(cfg!.mcpServers.filesystem.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]);
    expect(Buffer.isBuffer(cfg!._rawBytes)).toBe(true);
  });

  // T-MCPCFG-BAD-VERSION
  it("returns null when version !== 1", async () => {
    await writeFile(join(tmp, ".zone", "mcp.json"), JSON.stringify({ version: 2, mcpServers: {} }));
    expect(await loadDiskMcp(tmp)).toBeNull();
  });

  it("returns null on invalid JSON", async () => {
    await writeFile(join(tmp, ".zone", "mcp.json"), "{ invalid");
    expect(await loadDiskMcp(tmp)).toBeNull();
  });

  it("returns null when mcpServers is missing", async () => {
    await writeFile(join(tmp, ".zone", "mcp.json"), JSON.stringify({ version: 1 }));
    expect(await loadDiskMcp(tmp)).toBeNull();
  });

  // T-MCPCFG-NO-COMMAND
  it("skips entries missing command, keeps others", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        bad: { args: ["foo"] },
        good: { command: "npx", args: ["some-server"] },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
    expect(cfg!.mcpServers.good.command).toBe("npx");
  });

  it("skips entries with non-string-array args", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        bad: { command: "npx", args: [1, 2, 3] },
        good: { command: "node", args: ["server.js"] },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
  });

  it("skips entries with non-string-values env", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        bad: { command: "npx", env: { KEY: 42 } },
        good: { command: "node" },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
  });

  // ── `tools` allowlist (per-server tool filtering) ──────────────────────────
  //
  // The field is an ALLOWLIST, not a denylist — see the ledger entry for why
  // (it fails closed, and this codebase already paid for the denylist shape
  // once when a name denylist "granted whatever it forgot"). These cases pin
  // the parse layer only; whether a listed name actually matches a tool the
  // server provides is not knowable until after listTools, and is pinned in
  // mcpClientManager.test.ts instead.

  it("parses a valid tools allowlist", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        playwright: { command: "npx", args: ["-y", "@playwright/mcp"], tools: ["browser_navigate", "browser_find"] },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    expect(cfg!.mcpServers.playwright!.tools).toEqual(["browser_navigate", "browser_find"]);
  });

  it("leaves tools undefined when the field is absent — the unchanged-by-default case", async () => {
    await writeFile(join(tmp, ".zone", "mcp.json"), VALID_MCP_JSON);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    // Absent, not an empty array: an empty array means "expose nothing" and is
    // rejected below, so the two must never be conflated at the parse layer.
    expect(cfg!.mcpServers.filesystem!.tools).toBeUndefined();
    expect("tools" in cfg!.mcpServers.filesystem!).toBe(false);
  });

  it("skips entries whose tools is not an array, keeps others", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        bad: { command: "npx", tools: "browser_navigate" },
        good: { command: "node" },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    // Per-server skip, not a whole-file null: one server's bad filter must not
    // disable another server. Mirrors the args/env precedent above.
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
  });

  it("skips entries whose tools has non-string elements, keeps others", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        bad: { command: "npx", tools: ["browser_navigate", 42] },
        good: { command: "node" },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
  });

  // ── `requireApproval` override (per-tool approval declaration) ─────────────
  //
  // Bidirectional by construction: true forces the approval gate ON for a tool the server declared
  // read-only, false forces it OFF for one the server declared destructive, and an absent key falls
  // back to the server's own annotation. A map rather than two arrays (`require: []` / `skip: []`)
  // because two arrays can name the same tool in both and then need a documented precedence rule —
  // a map cannot contradict itself.

  it("parses a valid requireApproval override in both directions", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        playwright: {
          command: "npx",
          requireApproval: { browser_navigate: false, browser_snapshot: true },
        },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    expect(cfg!.mcpServers.playwright!.requireApproval).toEqual({
      browser_navigate: false,
      browser_snapshot: true,
    });
  });

  it("leaves requireApproval undefined when absent — the unchanged-by-default case", async () => {
    await writeFile(join(tmp, ".zone", "mcp.json"), VALID_MCP_JSON);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg!.mcpServers.filesystem!.requireApproval).toBeUndefined();
    expect("requireApproval" in cfg!.mcpServers.filesystem!).toBe(false);
  });

  it("accepts an empty requireApproval object — unlike tools:[], 'no overrides' is coherent", async () => {
    // Deliberate asymmetry with the tools:[] case above. `tools: []` means "expose nothing", which
    // is the silent zero-tool state item 410 exists to prevent. `requireApproval: {}` means "no
    // overrides", which is exactly the same as omitting the field — harmless, so not an error.
    const json = JSON.stringify({
      version: 1,
      mcpServers: { good: { command: "npx", requireApproval: {} } },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
    expect(cfg!.mcpServers.good!.requireApproval).toEqual({});
  });

  it("skips entries whose requireApproval is not an object, keeps others", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        bad: { command: "npx", requireApproval: ["browser_click"] },
        good: { command: "node" },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
  });

  it("skips entries whose requireApproval has non-boolean values, keeps others", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        bad: { command: "npx", requireApproval: { browser_click: "yes" } },
        good: { command: "node" },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
  });

  it("skips entries with an empty tools array — 'expose nothing' is a mistake, not an intent", async () => {
    const json = JSON.stringify({
      version: 1,
      mcpServers: {
        bad: { command: "npx", tools: [] },
        good: { command: "node" },
      },
    });
    await writeFile(join(tmp, ".zone", "mcp.json"), json);
    const cfg = await loadDiskMcp(tmp);
    expect(cfg).not.toBeNull();
    // Registering a server that can offer nothing is exactly the silent
    // zero-tool state this whole field exists to make visible.
    expect(Object.keys(cfg!.mcpServers)).toEqual(["good"]);
  });
});

// T-MCPCFG-HASH
describe("mcpConfigHash", () => {
  it("produces a hex sha256 string", () => {
    const buf = Buffer.from("hello");
    const hash = mcpConfigHash(buf);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("whitespace change produces different hash", () => {
    const a = mcpConfigHash(Buffer.from('{"version":1}'));
    const b = mcpConfigHash(Buffer.from('{"version": 1}'));
    expect(a).not.toBe(b);
  });
});

// T-ENV-MINIMAL-BASE
describe("buildMcpBaseEnv", () => {
  it("does not include ANTHROPIC_API_KEY or OPENAI_API_KEY", () => {
    const env = buildMcpBaseEnv();
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("includes PATH when present", () => {
    const orig = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    const env = buildMcpBaseEnv();
    expect(env.PATH).toBe("/usr/bin:/bin");
    process.env.PATH = orig;
  });
});

// T-ENV-EXPAND-KNOWN / T-ENV-EXPAND-UNKNOWN
describe("expandMcpEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("T-ENV-EXPAND-KNOWN: expands ${VAR} from process.env", () => {
    process.env["ZONE_TEST_TOKEN_XYZ"] = "test-token-value";
    try {
      const expanded = expandMcpEnv(
        { TOKEN: "${ZONE_TEST_TOKEN_XYZ}" },
        "test-server"
      );
      expect(expanded.TOKEN).toBe("test-token-value");
    } finally {
      delete process.env["ZONE_TEST_TOKEN_XYZ"];
    }
  });

  it("T-ENV-EXPAND-UNKNOWN: unknown var expands to empty string", () => {
    delete process.env["ZONE_DEFINITELY_NOT_SET_12345"];
    const expanded = expandMcpEnv(
      { TOKEN: "${ZONE_DEFINITELY_NOT_SET_12345}" },
      "test-server"
    );
    expect(expanded.TOKEN).toBe("");
  });

  it("leaves values without ${} unchanged", () => {
    const expanded = expandMcpEnv({ KEY: "literal-value" }, "s");
    expect(expanded.KEY).toBe("literal-value");
  });

  it("expands multiple vars in one value", () => {
    process.env["ZONE_A_TEST"] = "hello";
    process.env["ZONE_B_TEST"] = "world";
    try {
      const expanded = expandMcpEnv({ MSG: "${ZONE_A_TEST} ${ZONE_B_TEST}" }, "s");
      expect(expanded.MSG).toBe("hello world");
    } finally {
      delete process.env["ZONE_A_TEST"];
      delete process.env["ZONE_B_TEST"];
    }
  });
});
