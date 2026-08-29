import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { log } from "../utils/logger.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Allowlist of this server's tool names to expose to the model. Absent means
   * expose everything the server reports — the unchanged default.
   *
   * ALLOWLIST, not a denylist, and the choice is load-bearing. An allowlist
   * fails closed: a tool a server adds in a later release is not offered until
   * someone names it. A denylist fails open, which this codebase has already
   * paid for once — see `READ_ONLY_CAPABILITIES` in tools/capabilities.ts, whose
   * comment records the name denylist that "granted whatever it forgot, which is
   * how `multi_edit` reached a read-only run." The allowlist's own weakness (a
   * server renames a tool and the entry silently matches nothing) is reported
   * rather than swallowed — see `[zone-mcp-tools-filtered]` in mcpClientManager.
   *
   * NOT A SANDBOX. The MCP protocol has no client-side tool filter (SDK 1.29.0:
   * `tools/list` params are `_meta`/`cursor` only, and no ClientCapability
   * restricts a server's surface), so the subprocess still starts, still reports
   * every tool, and still holds every capability it had. This withholds tools
   * from the MODEL. It cuts prompt cost and narrows what the model can invoke;
   * it does not constrain the server process itself.
   */
  tools?: string[];
  /**
   * Per-tool approval override. `true` forces the approval gate ON for that tool, `false` forces it
   * OFF, and an absent key falls back to the server's own `destructiveHint` annotation (with an
   * unannotated tool gated — fail closed). Absent field means "no overrides", the unchanged default.
   *
   * BIDIRECTIONAL BY CONSTRUCTION, which is the requirement: the server's classification is a hint
   * about its own internals, and it can be wrong for a project in either direction. `@playwright/mcp`
   * declares `browser_navigate` destructive because navigation changes browser state — true, but not
   * the risk an approval gate exists for in a project that only loads pages to inspect them. The
   * same coarseness runs the other way for `browser_evaluate`, which is destructive in a much
   * stronger sense than the single flag conveys.
   *
   * A MAP RATHER THAN TWO ARRAYS (`require: []` / `skip: []`): two arrays can name the same tool in
   * both and then need a documented precedence rule to resolve it. A map cannot contradict itself.
   * The field name is chosen so the value reads as the sentence it is —
   * `"requireApproval": { "browser_navigate": false }` is unambiguous, where a bare `"approval"`
   * key could be read as "not approved".
   *
   * NO BUILT-IN EXCEPTION LIST accompanies this, deliberately: shipping one would mean Zone knowing
   * specific servers' tool names, and `browser_navigate` is one server's name for one operation
   * today. The exception belongs in the user's own file, where it is visible.
   */
  requireApproval?: Record<string, boolean>;
}

export interface McpConfig {
  version: 1;
  mcpServers: Record<string, McpServerConfig>;
  /** Raw file bytes for hash re-verification. NOT written to disk. */
  _rawBytes?: Buffer;
}

function validateServer(raw: unknown, name: string): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.command !== "string" || !obj.command.trim()) {
    log("[zone-mcp-load-warn]", `server '${name}': missing or empty 'command' — skipping`);
    return null;
  }
  const server: McpServerConfig = { command: obj.command };
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args) || !obj.args.every((a) => typeof a === "string")) {
      log("[zone-mcp-load-warn]", `server '${name}': 'args' must be string[] — skipping`);
      return null;
    }
    server.args = obj.args as string[];
  }
  if (obj.env !== undefined) {
    if (
      !obj.env ||
      typeof obj.env !== "object" ||
      Array.isArray(obj.env) ||
      !Object.values(obj.env).every((v) => typeof v === "string")
    ) {
      log("[zone-mcp-load-warn]", `server '${name}': 'env' must be Record<string,string> — skipping`);
      return null;
    }
    server.env = obj.env as Record<string, string>;
  }
  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools) || !obj.tools.every((t) => typeof t === "string")) {
      log("[zone-mcp-load-warn]", `server '${name}': 'tools' must be string[] — skipping`);
      return null;
    }
    // Empty is rejected rather than honoured. Read literally it means "expose
    // nothing", which no one writes on purpose — and honouring it would register
    // a server that can offer the model nothing at all, silently. That silent
    // zero-tool state is the exact failure this field exists to make visible, so
    // it is refused at the parse layer where the file that caused it can be named.
    // Deliberately NOT conflated with the field being absent, which means "expose
    // everything" and is the unchanged default.
    if (obj.tools.length === 0) {
      log("[zone-mcp-load-warn]", `server '${name}': 'tools' is empty — omit the field to expose all tools — skipping`);
      return null;
    }
    server.tools = obj.tools as string[];
  }
  if (obj.requireApproval !== undefined) {
    const ra = obj.requireApproval;
    if (
      !ra ||
      typeof ra !== "object" ||
      Array.isArray(ra) ||
      !Object.values(ra).every((v) => typeof v === "boolean")
    ) {
      log("[zone-mcp-load-warn]", `server '${name}': 'requireApproval' must be Record<string,boolean> — skipping`);
      return null;
    }
    // Empty IS accepted here, unlike `tools: []` above — and the asymmetry is deliberate rather
    // than an oversight. `tools: []` reads as "expose nothing", which no one writes on purpose and
    // which produces the silent zero-tool server this field exists to prevent. `requireApproval: {}`
    // reads as "no overrides", which is exactly what omitting the field means — harmless, so
    // refusing it would be pedantry rather than protection.
    server.requireApproval = ra as Record<string, boolean>;
  }
  return server;
}

export async function loadDiskMcp(repoPath: string): Promise<McpConfig | null> {
  const mcpPath = join(repoPath, ".zone", "mcp.json");
  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(mcpPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes.toString("utf-8"));
  } catch {
    log("[zone-mcp-load-error]", "mcp.json is not valid JSON — skipping");
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    log("[zone-mcp-load-error]", "mcp.json must be an object — skipping");
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) {
    log("[zone-mcp-load-error]", `mcp.json version must be 1, got ${String(obj.version)} — skipping`);
    return null;
  }

  if (!obj.mcpServers || typeof obj.mcpServers !== "object" || Array.isArray(obj.mcpServers)) {
    log("[zone-mcp-load-error]", "mcp.json missing 'mcpServers' object — skipping");
    return null;
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
    const validated = validateServer(raw, name);
    if (validated) mcpServers[name] = validated;
  }

  return { version: 1, mcpServers, _rawBytes: rawBytes };
}

export function mcpConfigHash(rawBytes: Buffer): string {
  return createHash("sha256").update(rawBytes).digest("hex");
}

const MCP_BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"];

export function buildMcpBaseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of MCP_BASE_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

export function expandMcpEnv(
  env: Record<string, string>,
  serverName: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      const resolved = process.env[varName];
      if (resolved === undefined) {
        log("[zone-mcp-env-warn]", `server '${serverName}': unknown env var '${varName}' — using empty string`);
        return "";
      }
      return resolved;
    });
  }
  return out;
}
