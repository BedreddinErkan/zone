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
