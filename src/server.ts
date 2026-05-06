import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { log, debugLog } from "./utils/logger.js";

debugLog("[zone] server.ts loading...");

function loadCliAuthConfig(): void {
  const configPath = path.join(os.homedir(), ".zone", "config.json");

  if (!existsSync(configPath)) {
    return;
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as { userId?: unknown; email?: unknown };
    const userId = typeof parsed.userId === "string" ? parsed.userId.trim() : "";
    const email = typeof parsed.email === "string" ? parsed.email.trim() : "";

    if (!userId) {
      return;
    }

    process.env.ZONE_USER_ID = userId;
    if (email) {
      process.env.ZONE_USER_EMAIL = email;
    }

    log(`[zone] Loaded CLI auth for user ${userId}`);
  } catch {
    console.warn("[zone] Warning: could not parse ~/.zone/config.json");
  }
}

loadCliAuthConfig();

// Load the API server synchronously so this wrapper stays compatible with CJS startup.
// `zone serve` imports this file through the current CommonJS-oriented serve path.
// Using require here avoids top-level await while preserving the same startup behavior.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiServer = require("./api/server.js") as typeof import("./api/server.js");

export const app = apiServer.app;
export const startServer = apiServer.startServer;
