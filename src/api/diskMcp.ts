import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { log } from "../utils/logger.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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
