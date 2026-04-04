import fg from "fast-glob";
import path from "node:path";
import type { RepoFile } from "../types/project.js";

function detectCategory(filePath: string): RepoFile["category"] {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("client/")) return "frontend";
  if (normalized.startsWith("server/")) return "backend";
  return "unknown";
}

export async function scanRepo(targetPath: string): Promise<RepoFile[]> {
  const entries = await fg(
    [
      // JavaScript/TypeScript projects
      "client/src/**/*.{js,jsx,ts,tsx,css}",
      "server/**/*.{js,ts}",
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
        "**/coverage/**",
        "**/.agent-cache/**",
        "**/.agent-patches/**",
        "**/.agent-backups/**",
        "**/__pycache__/**",
        "**/.pytest_cache/**",
      ],
    }
  );

  return entries.map((entry) => {
    const extension = path.extname(entry).replace(".", "").toLowerCase();
    return {
      path: entry,
      absolutePath: path.join(targetPath, entry),
      extension,
      category: detectCategory(entry),
    };
  });
}