import { chromium, type Browser, type Page } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs/promises";

export interface VerifyVisualInput {
  path: string;
  description?: string | null;
  viewport?: { width: number; height: number } | null;
  waitFor?: string | null;
}

export interface VerifyVisualResult {
  success: boolean;
  screenshotPath?: string;
  pageTitle?: string;
  consoleErrors?: string[];
  error?: string;
}

const SCREENSHOT_DIR = path.join(process.cwd(), ".zone", "screenshots");
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const NAV_TIMEOUT_MS = 15_000;
const WAIT_SELECTOR_TIMEOUT_MS = 5_000;
export const SCREENSHOT_CAP_PER_RUN = 5;

const CONSOLE_NOISE_PATTERNS: RegExp[] = [
  /Failed to load resource.*\b(400|404)\b/i,
  /A tree hydrated but some attributes/i,
  /hydration[- ]mismatch/i,
  /\[Fast Refresh\]/i,
  /Download the React DevTools/i,
  /bis_register|bis_skin_checked|__processed_/i,
  /webextension|chrome-extension:|moz-extension:/i,
  /ResizeObserver loop/i,
];

function isConsoleNoise(text: string): boolean {
  return CONSOLE_NOISE_PATTERNS.some((p) => p.test(text));
}

let browserSingleton: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserSingleton || !browserSingleton.isConnected()) {
    browserSingleton = await chromium.launch({ headless: true });
  }
  return browserSingleton;
}

export async function shutdownVerifyVisualBrowser(): Promise<void> {
  if (browserSingleton) {
    try {
      await browserSingleton.close();
    } catch {
      // Best-effort shutdown.
    }
    browserSingleton = null;
  }
}

function normalizeViewport(
  viewport: VerifyVisualInput["viewport"]
): { width: number; height: number } {
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width: Math.floor(width), height: Math.floor(height) };
  }
  return DEFAULT_VIEWPORT;
}

export async function runVerifyVisual(
  input: VerifyVisualInput,
  context: { devServerBaseUrl: string; runId: string; screenshotCount: number }
): Promise<VerifyVisualResult> {
  if (context.screenshotCount >= SCREENSHOT_CAP_PER_RUN) {
    return {
      success: false,
      error: `Screenshot cap reached (${SCREENSHOT_CAP_PER_RUN} per run). Cannot take more.`,
    };
  }

  const fullUrl = (() => {
    const url = new URL(input.path || "/", context.devServerBaseUrl);
    url.searchParams.set("screenshot", "1");
    return url.toString();
  })();
  const consoleErrors: string[] = [];
  let page: Page | null = null;

  try {
    const browser = await getBrowser();
    page = await browser.newPage({
      viewport: normalizeViewport(input.viewport),
    });

    await page.emulateMedia({ reducedMotion: "reduce" });

    page.on("pageerror", (err) => {
      const message = `pageerror: ${err.message}`;
      if (!isConsoleNoise(message)) {
        consoleErrors.push(message);
      }
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const message = msg.text();
        if (!isConsoleNoise(message)) {
          consoleErrors.push(message);
        }
      }
    });

    await page.goto(fullUrl, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: "load",
    });

    const hash = new URL(input.path || "/", context.devServerBaseUrl).hash;
    if (hash && hash.length > 1) {
      const scrollResult = await page.evaluate(`
        (function() {
          var selector = ${JSON.stringify(hash)};
          var el = document.querySelector(selector);
          if (!el) return { found: false, scrollY: window.scrollY };
          var before = window.scrollY;
          el.scrollIntoView({ behavior: "instant", block: "start" });
          return {
            found: true,
            scrollYBefore: before,
            scrollYAfter: window.scrollY,
            elementTop: el.getBoundingClientRect().top,
            docHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
          };
        })()
      `).catch((err: unknown) => ({ error: String(err) }));

      console.log("[zone-verify-scroll]", JSON.stringify({
        runId: context.runId,
        hash,
        result: scrollResult,
      }));

      await page.waitForTimeout(1000);
    }

    if (input.waitFor) {
      await page.waitForSelector(input.waitFor, { timeout: WAIT_SELECTOR_TIMEOUT_MS }).catch(() => null);
    }

    await page.waitForLoadState("networkidle").catch(() => { /* best-effort */ });
    await page.waitForTimeout(500);

    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    const filename = `${context.runId}-${Date.now()}.png`;
    const screenshotPath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const pageTitle = await page.title();

    return {
      success: true,
      screenshotPath,
      pageTitle,
      consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Best-effort page cleanup.
      }
    }
  }
}
