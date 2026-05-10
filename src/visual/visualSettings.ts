// Phase I.2: persistent settings for the verify_visual tool. Lives next to
// the Phase F usage-limits config in ~/.zone/, sync FS to match that pattern.
//
// The agent calls verify_visual with an explicit viewport and path; this
// module supplies the dev-server base URL (where the user's app is running)
// and a fallback viewport when the agent doesn't specify one.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface VisualVerificationSettings {
  devServerBaseUrl: string;
  defaultViewport: { width: number; height: number };
  /** Phase I.2 placeholder — persists but no behavior yet (Phase I.3 wires it). */
  autoVerifyAfterPatch: boolean;
}

const DEFAULTS: VisualVerificationSettings = {
  devServerBaseUrl: "http://localhost:3000",
  defaultViewport: { width: 1280, height: 720 },
  autoVerifyAfterPatch: false,
};

const SETTINGS_DIR = join(homedir(), ".zone");
const SETTINGS_PATH = join(SETTINGS_DIR, "visual-verification.json");

const VIEWPORT_MIN_WIDTH = 320;
const VIEWPORT_MAX_WIDTH = 3840;
const VIEWPORT_MIN_HEIGHT = 240;
const VIEWPORT_MAX_HEIGHT = 2160;

export function getVisualSettingsPath(): string {
  return SETTINGS_PATH;
}

function validateUrl(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) return DEFAULTS.devServerBaseUrl;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULTS.devServerBaseUrl;
    }
    // Strip trailing slash so URL joining via `new URL(path, base)` is predictable.
    const out = parsed.toString();
    return out.endsWith("/") && parsed.pathname === "/" ? out.slice(0, -1) : out;
  } catch {
    return DEFAULTS.devServerBaseUrl;
  }
}

function validateViewport(v: unknown): { width: number; height: number } {
  const obj = (v ?? {}) as { width?: unknown; height?: unknown };
  const w = Number(obj.width);
  const h = Number(obj.height);
  const widthOk =
    Number.isFinite(w) &&
    Number.isInteger(w) &&
    w >= VIEWPORT_MIN_WIDTH &&
    w <= VIEWPORT_MAX_WIDTH;
  const heightOk =
    Number.isFinite(h) &&
    Number.isInteger(h) &&
    h >= VIEWPORT_MIN_HEIGHT &&
    h <= VIEWPORT_MAX_HEIGHT;
  return {
    width: widthOk ? w : DEFAULTS.defaultViewport.width,
    height: heightOk ? h : DEFAULTS.defaultViewport.height,
  };
}

function normalizeSettings(raw: unknown): VisualVerificationSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    devServerBaseUrl: validateUrl(r.devServerBaseUrl),
    defaultViewport: validateViewport(r.defaultViewport),
    autoVerifyAfterPatch:
      typeof r.autoVerifyAfterPatch === "boolean"
        ? r.autoVerifyAfterPatch
        : DEFAULTS.autoVerifyAfterPatch,
  };
}

export function loadVisualSettings(): VisualVerificationSettings {
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf-8");
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS, defaultViewport: { ...DEFAULTS.defaultViewport } };
  }
}

export function saveVisualSettings(
  settings: VisualVerificationSettings
): VisualVerificationSettings {
  const validated = normalizeSettings(settings);
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(validated, null, 2), "utf-8");
  return validated;
}

export function getVisualSettingsDefaults(): VisualVerificationSettings {
  return { ...DEFAULTS, defaultViewport: { ...DEFAULTS.defaultViewport } };
}
