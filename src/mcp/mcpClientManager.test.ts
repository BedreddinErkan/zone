import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpClientManager } from "./mcpClientManager.js";
import { resolveToolList } from "../tools/toolRegistry.js";

// ── Hoisted mock fn references ──────────────────────────────────────────────
// These are module-level singletons that represent the shared mock client.
// mockReset resets vi.fn() state but not the plain object holding them.
const _mockClient = vi.hoisted(() => ({
  connect:   vi.fn<() => Promise<void>>(),
  listTools: vi.fn<() => Promise<{ tools: unknown[] }>>(),
  callTool:  vi.fn<() => Promise<unknown>>(),
  close:     vi.fn<() => Promise<void>>(),
}));

// Transport pid can be overridden per-test.
const _mockTransport = vi.hoisted(() => ({ pid: null as number | null }));

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/types.js", () => {
  class MockMcpError extends Error {
    code: number;
    constructor(message: string, code: number) {
      super(message);
      this.name = "McpError";
      this.code = code;
    }
  }
  return { McpError: MockMcpError };
});

// ── Helpers ──────────────────────────────────────────────────────────────────
let _toolCounter = 0;
function uniqueServer(): string { return `test_sv_${++_toolCounter}`; }
function uniqueTool(): string { return `tool_${_toolCounter}`; }

function makeTool(name: string) {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: {} },
  };
}

// ── Test setup ───────────────────────────────────────────────────────────────
beforeEach(() => {
  _mockTransport.pid = 99999;

  // Re-apply implementations after mockReset clears them.
  vi.mocked(Client).mockImplementation(() => _mockClient as unknown as Client);
  vi.mocked(StdioClientTransport).mockImplementation(
    () => ({ pid: _mockTransport.pid }) as unknown as StdioClientTransport
  );

  // Default: connect + listTools succeed with no tools; close succeeds.
  _mockClient.connect.mockResolvedValue(undefined);
  _mockClient.listTools.mockResolvedValue({ tools: [] });
  _mockClient.close.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── T-CONNECT-SUCCESS ────────────────────────────────────────────────────────
it("T-CONNECT-SUCCESS: calls connect + listTools; registers mcp__ tool", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });

  const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

  expect(_mockClient.connect).toHaveBeenCalledTimes(1);
  expect(_mockClient.listTools).toHaveBeenCalledTimes(1);
  expect(manager.registeredToolNames()).toContain(`mcp__${server}__${tool}`);
});

// ── T-CONNECT-TIMEOUT ────────────────────────────────────────────────────────
it("T-CONNECT-TIMEOUT: skips server without throwing when connect hangs", async () => {
  vi.useFakeTimers();
  try {
    _mockClient.connect.mockReturnValue(new Promise<void>(() => {})); // never resolves

    const connectPromise = McpClientManager.connect(
      { slow: { command: "sleep" } }, "/tmp"
    );
    await vi.advanceTimersByTimeAsync(11_000);
    const manager = await connectPromise;

    expect(manager.registeredToolNames()).toHaveLength(0);
    // close is called on timeout path
    expect(_mockClient.close).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

// ── T-CONNECT-PARTIAL ────────────────────────────────────────────────────────
it("T-CONNECT-PARTIAL: skips failing server; registers succeeding server's tools", async () => {
  const serverA = uniqueServer();
  const serverB = uniqueServer();
  const toolB = uniqueTool();

  let connectCallCount = 0;
  _mockClient.connect.mockImplementation(async () => {
    if (++connectCallCount === 1) throw new Error("Connection refused");
  });
  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(toolB)] });

  const manager = await McpClientManager.connect(
    { [serverA]: { command: "bad" }, [serverB]: { command: "good" } }, "/tmp"
  );

  const names = manager.registeredToolNames();
  expect(names).not.toContain(`mcp__${serverA}__${toolB}`);
  expect(names).toContain(`mcp__${serverB}__${toolB}`);
});

// ── T-REGISTER-COMPLEX-TIER ──────────────────────────────────────────────────
it("T-REGISTER-COMPLEX-TIER: resolveToolList(undefined) includes mcp tool", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });

  await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

  const names = resolveToolList(undefined).map((t) => t.name);
  expect(names).toContain(`mcp__${server}__${tool}`);
});

// ── T-REGISTER-SIMPLE-EXCLUDE ────────────────────────────────────────────────
it("T-REGISTER-SIMPLE-EXCLUDE: allowToolNames (simple tier) excludes mcp tools", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });

  await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

  const SIMPLE = new Set(["read_file", "write_file", "apply_patch", "multi_edit", "run_command"]);
  const names = resolveToolList({ allowToolNames: SIMPLE }).map((t) => t.name);
  expect(names).not.toContain(`mcp__${server}__${tool}`);
});

// ── T-SUBAGENT-EXCLUDE ───────────────────────────────────────────────────────
it("T-SUBAGENT-EXCLUDE: capability-allow without mcp.call excludes mcp tools", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });

  await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

  const names = resolveToolList({ allow: new Set(["fs.read", "fs.write"]) }).map((t) => t.name);
  expect(names).not.toContain(`mcp__${server}__${tool}`);
});

// ── T-PROXY-SUCCESS ──────────────────────────────────────────────────────────
it("T-PROXY-SUCCESS: returns ToolResult with untrusted prefix and success:true", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  const namespacedName = `mcp__${server}__${tool}`;

  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });
  _mockClient.callTool.mockResolvedValue({
    content: [{ type: "text", text: "Hello from MCP" }],
    isError: false,
  });

  const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");
  const result = await manager.callTool(namespacedName, { arg: "x" });

  expect(result.success).toBe(true);
  expect(result.output).toContain("[NOTE: Content below is fetched from an external source.");
  expect(result.output).toContain("Hello from MCP");
});

// ── T-PROXY-ISERROR ──────────────────────────────────────────────────────────
it("T-PROXY-ISERROR: isError:true → success:false", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  const namespacedName = `mcp__${server}__${tool}`;

  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });
  _mockClient.callTool.mockResolvedValue({
    content: [{ type: "text", text: "Something went wrong" }],
    isError: true,
  });

  const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");
  const result = await manager.callTool(namespacedName, {});

  expect(result.success).toBe(false);
});

// ── T-PROXY-TIMEOUT ──────────────────────────────────────────────────────────
it("T-PROXY-TIMEOUT: SDK timeout → timed-out result; server NOT closed; next call works", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  const namespacedName = `mcp__${server}__${tool}`;

  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });
  _mockClient.callTool
    .mockRejectedValueOnce(new McpError("request timeout", -32001))
    .mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }], isError: false });

  const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

  const timedOut = await manager.callTool(namespacedName, {});
  expect(timedOut.success).toBe(false);
  expect(timedOut.output).toContain("did not respond in time");
  expect(timedOut.output).toContain("server remains connected");
  expect(_mockClient.close).not.toHaveBeenCalled();

  // Server still alive — subsequent call succeeds.
  const ok = await manager.callTool(namespacedName, {});
  expect(ok.success).toBe(true);
});

// ── T-PROXY-TRANSPORT-ERROR ──────────────────────────────────────────────────
it("T-PROXY-TRANSPORT-ERROR: transport error → unavailable + client.close() called", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  const namespacedName = `mcp__${server}__${tool}`;

  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });
  _mockClient.callTool.mockRejectedValue(new Error("ECONNRESET"));

  const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");
  const result = await manager.callTool(namespacedName, {});

  expect(result.success).toBe(false);
  expect(result.output).toContain("unavailable");
  expect(_mockClient.close).toHaveBeenCalled();
});

// ── T-PROXY-NON-TEXT-CONTENT ─────────────────────────────────────────────────
it("T-PROXY-NON-TEXT-CONTENT: image content → placeholder; text preserved", async () => {
  const server = uniqueServer();
  const tool = uniqueTool();
  const namespacedName = `mcp__${server}__${tool}`;

  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(tool)] });
  _mockClient.callTool.mockResolvedValue({
    content: [
      { type: "text", text: "Prefix text" },
      { type: "image", data: "base64data", mimeType: "image/png" },
    ],
    isError: false,
  });

  const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");
  const result = await manager.callTool(namespacedName, {});

  expect(result.output).toContain("Prefix text");
  expect(result.output).toContain("[non-text MCP content omitted]");
  expect(result.output).not.toContain("base64data");
});

// ── T-COLLISION-WARN ─────────────────────────────────────────────────────────
it("T-COLLISION-WARN: two servers same local tool name → both namespaced, no crash", async () => {
  const toolName = `shared_tool_${++_toolCounter}`;
  const serverA = uniqueServer();
  const serverB = uniqueServer();

  _mockClient.listTools.mockResolvedValue({ tools: [makeTool(toolName)] });

  const manager = await McpClientManager.connect(
    { [serverA]: { command: "echo" }, [serverB]: { command: "echo" } }, "/tmp"
  );

  const names = manager.registeredToolNames();
  // Both are namespaced separately — no collision at the registry level
  expect(names).toContain(`mcp__${serverA}__${toolName}`);
  expect(names).toContain(`mcp__${serverB}__${toolName}`);
});

// ── T-CLOSEALL-KILLS ─────────────────────────────────────────────────────────
it("T-CLOSEALL-KILLS: closeAll calls client.close() per server", async () => {
  const server = uniqueServer();
  _mockTransport.pid = 54321;
  vi.mocked(StdioClientTransport).mockImplementation(
    () => ({ pid: 54321 }) as unknown as StdioClientTransport
  );

  const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");
  await manager.closeAll();

  expect(_mockClient.close).toHaveBeenCalledTimes(1);
});

// ── T-CLOSEALL-PARTIAL-FAIL ──────────────────────────────────────────────────
it("T-CLOSEALL-PARTIAL-FAIL: one close() throws; others still complete", async () => {
  const serverA = uniqueServer();
  const serverB = uniqueServer();
  _mockClient.listTools.mockResolvedValue({ tools: [] });

  let closeCount = 0;
  _mockClient.close.mockImplementation(async () => {
    if (++closeCount === 1) throw new Error("close failed");
  });

  const manager = await McpClientManager.connect(
    { [serverA]: { command: "echo" }, [serverB]: { command: "echo" } }, "/tmp"
  );

  await expect(manager.closeAll()).resolves.toBeUndefined();
  expect(_mockClient.close).toHaveBeenCalledTimes(2);
});

// ── T-KILLALLSYNC ────────────────────────────────────────────────────────────
describe("T-KILLALLSYNC", () => {
  it("synchronously SIGTERMs each connected server process", async () => {
    const fakePid = 77777;
    _mockTransport.pid = fakePid;
    vi.mocked(StdioClientTransport).mockImplementation(
      () => ({ pid: fakePid }) as unknown as StdioClientTransport
    );

    const server = uniqueServer();
    const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    manager.killAllSync();

    expect(processKill).toHaveBeenCalledWith(fakePid, "SIGTERM");
    processKill.mockRestore();
  });

  it("does not throw when process is already dead (ESRCH)", async () => {
    _mockTransport.pid = 1;

    const server = uniqueServer();
    const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

    const processKill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });

    expect(() => manager.killAllSync()).not.toThrow();
    processKill.mockRestore();
  });
});

// ── Edge: unknown tool name ───────────────────────────────────────────────────
it("callTool with unknown name → success:false", async () => {
  const manager = await McpClientManager.connect({}, "/tmp");
  const result = await manager.callTool("mcp__nonexistent__tool", {});
  expect(result.success).toBe(false);
  expect(result.output).toContain("mcp tool not found");
});

// ── Per-server tool allowlist ────────────────────────────────────────────────
//
// The server still starts and still returns its FULL tools/list — the MCP
// protocol has no client-side tool filter (checked against SDK 1.29.0:
// ListToolsRequest params are only `_meta`/`cursor`, and no ClientCapability
// restricts a server's surface). Zone drops the unlisted ones locally, between
// listTools and registerTool. These tests assert on what the model can reach —
// registeredToolNames() — which is the thing the filter is for; they do NOT
// claim the server process was constrained, because it was not.
describe("tools allowlist", () => {
  it("T-FILTER-ALLOW: only listed tools are registered", async () => {
    const server = uniqueServer();
    _mockClient.listTools.mockResolvedValue({
      tools: [makeTool("browser_navigate"), makeTool("browser_find"), makeTool("browser_click")],
    });

    const manager = await McpClientManager.connect(
      { [server]: { command: "echo", tools: ["browser_navigate", "browser_find"] } },
      "/tmp"
    );

    const names = manager.registeredToolNames();
    expect(names).toContain(`mcp__${server}__browser_navigate`);
    expect(names).toContain(`mcp__${server}__browser_find`);
    // The whole point: an unlisted MUTATING tool is never offered. This is the
    // half that narrows ledger item 408's ungated-mutation surface.
    expect(names).not.toContain(`mcp__${server}__browser_click`);
    expect(names).toHaveLength(2);
  });

  it("T-FILTER-ABSENT: no allowlist registers everything — the unchanged-by-default case", async () => {
    const server = uniqueServer();
    _mockClient.listTools.mockResolvedValue({
      tools: [makeTool("browser_navigate"), makeTool("browser_click")],
    });

    const manager = await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

    expect(manager.registeredToolNames()).toHaveLength(2);
    expect(manager.registeredToolNames()).toContain(`mcp__${server}__browser_click`);
  });

  it("T-FILTER-UNMATCHED: a name the server does not provide registers the rest and is reported", async () => {
    const server = uniqueServer();
    _mockClient.listTools.mockResolvedValue({
      tools: [makeTool("browser_navigate"), makeTool("browser_click")],
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    const manager = await McpClientManager.connect(
      // browser_snapshot is the rename case: an allowlist entry the server no
      // longer provides. The allowlist's one real weakness is that this breaks
      // silently — so it must not be silent.
      { [server]: { command: "echo", tools: ["browser_navigate", "browser_snapshot"] } },
      "/tmp"
    );

    expect(manager.registeredToolNames()).toEqual([`mcp__${server}__browser_navigate`]);

    const call = spy.mock.calls.find((c) => String(c[0]).includes("zone-mcp-tools-filtered"));
    expect(call, "an unmatched allowlist entry must be reported, not swallowed").toBeDefined();
    const payload = JSON.parse(String(call![1])) as Record<string, unknown>;
    expect(payload["serverName"]).toBe(server);
    expect(payload["available"]).toBe(2);
    expect(payload["offered"]).toBe(1);
    expect(payload["dropped"]).toBe(1);
    expect(payload["unmatched"]).toEqual(["browser_snapshot"]);
    spy.mockRestore();
  });

  it("T-FILTER-MARKER-UNCONDITIONAL: the marker is log(), not debugLog() — visible without ZONE_VERBOSE_LOGS", async () => {
    // Ledger item 409 records what debugLog gating costs: a failure nobody can
    // see without an env var. This suite runs with ZONE_VERBOSE_LOGS unset, so
    // observing the marker here IS the assertion that it is not gated.
    expect(process.env["ZONE_VERBOSE_LOGS"]).not.toBe("1");
    const server = uniqueServer();
    _mockClient.listTools.mockResolvedValue({ tools: [makeTool("a"), makeTool("b")] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await McpClientManager.connect({ [server]: { command: "echo", tools: ["a"] } }, "/tmp");

    expect(spy.mock.calls.some((c) => String(c[0]).includes("zone-mcp-tools-filtered"))).toBe(true);
    spy.mockRestore();
  });

  it("T-FILTER-NO-MARKER-WITHOUT-FILTER: an unfiltered server emits no filter marker", async () => {
    const server = uniqueServer();
    _mockClient.listTools.mockResolvedValue({ tools: [makeTool("a")] });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await McpClientManager.connect({ [server]: { command: "echo" } }, "/tmp");

    // Floor: a marker that fired unconditionally would make the assertions
    // above pass for the wrong reason.
    expect(spy.mock.calls.some((c) => String(c[0]).includes("zone-mcp-tools-filtered"))).toBe(false);
    spy.mockRestore();
  });
});
