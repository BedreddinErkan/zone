import fg from "fast-glob";
import path from "node:path";
import type { RepoFile } from "../types/project.js";

function detectCategory(filePath: string): RepoFile["category"] {
  const normalized = filePath.replace(/\\/g, "/");

  if (normalized.startsWith("client/")) {
    return "frontend";
  }

  if (normalized.startsWith("server/")) {
    return "backend";
  }

  return "unknown";
}

export async function scanRepo(targetPath: string): Promise<RepoFile[]> {
  const entries = await fg(
    [
      "client/src/**/*.{js,jsx,ts,tsx,css}",
      "server/**/*.{js,ts}",
      "*.json",
      "*.md"
    ],
    {
      cwd: targetPath,
      onlyFiles: true,
      dot: false,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.git/**",
        "**/.next/**",
        "**/coverage/**",
        "**/.agent-cache/**",
        "**/.agent-patches/**",
        "**/.agent-backups/**"
      ]
    }
  );

  return entries.map((entry) => {
    const extension = path.extname(entry).replace(".", "").toLowerCase();

    return {
      path: entry,
      absolutePath: path.join(targetPath, entry),
      extension,
      category: detectCategory(entry)
    };
  });
}