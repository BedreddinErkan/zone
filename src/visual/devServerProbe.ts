import { loadVisualSettings } from "./visualSettings.js";

const PROBE_TIMEOUT_MS = 3000;

export interface DevServerConfig {
  baseUrl: string;
  defaultViewport: { width: number; height: number };
}

let cachedConfig: DevServerConfig | null = null;

// Phase I.2: configuration source order is
//   1. Env var ZONE_DEV_SERVER_URL (CI/dev convenience, highest priority)
//   2. Settings file at ~/.zone/visual-verification.json (UI-managed)
//   3. Defaults from visualSettings (http://localhost:3000, 1280x720)
// invalidateDevServerCache() must be called whenever the settings file
// changes so the next probe picks up the new URL without a server restart.
export function getDevServerConfig(): DevServerConfig {
  if (cachedConfig) return cachedConfig;

  const settings = loadVisualSettings();
  const envUrl =
    typeof process.env.ZONE_DEV_SERVER_URL === "string" &&
    process.env.ZONE_DEV_SERVER_URL.trim()
      ? process.env.ZONE_DEV_SERVER_URL.trim()
      : null;

  cachedConfig = {
    baseUrl: envUrl ?? settings.devServerBaseUrl,
    defaultViewport: { ...settings.defaultViewport },
  };
  return cachedConfig;
}

export function setDevServerConfig(config: DevServerConfig): void {
  cachedConfig = config;
}

export function invalidateDevServerCache(): void {
  cachedConfig = null;
}

export async function probeDevServer(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(baseUrl, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
