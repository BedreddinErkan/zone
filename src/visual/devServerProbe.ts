const DEFAULT_DEV_SERVER_URL = "http://localhost:3000";
const PROBE_TIMEOUT_MS = 3000;

export interface DevServerConfig {
  baseUrl: string;
}

let cachedConfig: DevServerConfig | null = null;

export function getDevServerConfig(): DevServerConfig {
  if (cachedConfig) return cachedConfig;

  const baseUrl = process.env.ZONE_DEV_SERVER_URL || DEFAULT_DEV_SERVER_URL;
  cachedConfig = { baseUrl };
  return cachedConfig;
}

export function setDevServerConfig(config: DevServerConfig): void {
  cachedConfig = config;
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
