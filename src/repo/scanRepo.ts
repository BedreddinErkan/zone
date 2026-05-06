import fg from "fast-glob";
import path from "node:path";
import type { RepoFile } from "../types/project.js";

function detectCategory(filePath: string): RepoFile["category"] {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("client/")) return "frontend";
  if (normalized.startsWith("server/")) return "backend";
  return "unknown";
}

const DEFAULT_MAX_SCANNED_FILES = 2000;

function getMaxScannedFiles(): number {
  const raw = (process.env.ZONE_MAX_SCANNED_FILES ?? "").trim();
  const n = Number(raw);
  if (raw && Number.isFinite(n) && n > 0) {
    return Math.floor(n);
  }
  return DEFAULT_MAX_SCANNED_FILES;
}

export async function scanRepo(targetPath: string): Promise<RepoFile[]> {
  const entries = await fg(
    [
      // JavaScript/TypeScript projects
      "client/src/**/*.{js,jsx,ts,tsx,css}",
      "client/package.json",
      "server/**/*.{js,ts}",
      "server/package.json",
      "src/**/*.{js,jsx,ts,tsx}",
      // Java projects
      "src/**/*.java",
      "src/**/*.feature",
      "src/test/resources/**/*.feature",
      "features/**/*.feature",
      // Config files
      "*.json",
      "*.xml",
      "*.gradle",
      "*.md",
      "*.properties",
      // SQL / Database
      "**/*.sql",
      "**/migrations/**/*.sql",
      "**/db/**/*.sql",
      "**/alembic/**/*.py",
      "alembic.ini",
      "**/*.db",
      "my.cnf",
      "postgresql.conf",
      // Root config files — framework detection
      "playwright.config.ts",
      "playwright.config.js",
      "cypress.config.ts",
      "cypress.config.js",
      "pytest.ini",
      "conftest.py",
      "pyproject.toml",
      "testng.xml",
      // Cypress
      "cypress/**/*.{js,ts,feature}",
      // Playwright
      "tests/**/*.{js,ts}",
      "e2e/**/*.{js,ts}",
     // Python
      "tests/**/*.py",
      "**/*.py",
      // UI files
      "src/ui/**/*.{html,css,js}",
      "public/**/*.{html,css}",
      "*.html",
      // Modern JS framework conventions (Next.js App Router, Remix, SvelteKit, Astro, Vite, etc.)
      "app/**/*.{js,jsx,ts,tsx,css,scss}",
      "lib/**/*.{js,jsx,ts,tsx}",
      "components/**/*.{js,jsx,ts,tsx,css,scss}",
      "routes/**/*.{js,jsx,ts,tsx,svelte}",
      "pages/**/*.{js,jsx,ts,tsx}",
      "hooks/**/*.{js,ts,tsx}",
      "utils/**/*.{js,ts}",
      "styles/**/*.{css,scss}",
      "middleware.{ts,js}",
      "proxy.{ts,js}",
      "config/**/*.{js,ts,json}",
      // Root-level TS/MJS configs and entry files
      "*.{ts,tsx,mjs,cjs}",
    ],
    {
      cwd: targetPath,
      onlyFiles: true,
      dot: false,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/target/**",
        "**/.git/**",
        "**/.next/**",
        "**/.turbo/**",
        "**/.cache/**",
        "**/out/**",
        "**/coverage/**",
        "**/.agent-cache/**",
        "**/.agent-patches/**",
        "**/.agent-backups/**",
        "**/venv/**",
        "**/.venv/**",
        "**/env/**",
        "**/__pycache__/**",
        "**/*.pyc",
        "**/site-packages/**",
        "**/.pytest_cache/**",
      ],
    }
  );

  const cap = getMaxScannedFiles();
  let trimmed = entries;
  if (entries.length > cap) {
    console.warn(
      `[zone] scanRepo capped at ${cap} (found ${entries.length}). Set ZONE_MAX_SCANNED_FILES to override.`
    );
    trimmed = entries.slice(0, cap);
  }

  return trimmed.map((entry) => {
    const extension = path.extname(entry).replace(".", "").toLowerCase();
    return {
      path: entry,
      absolutePath: path.join(targetPath, entry),
      extension,
      category: detectCategory(entry),
    };
  });
}