import fs from "node:fs/promises";
import path from "node:path";
import type { SchemaSnapshot } from "../types/schema.js";

export async function loadSchemaSnapshot(projectRoot: string): Promise<SchemaSnapshot | null> {
  const candidatePaths = [
    path.join(projectRoot, ".agent-cache", "schema.json"),
    path.join(projectRoot, "schema.json"),
    path.join(projectRoot, "supabase-schema.json")
  ];

  for (const filePath of candidatePaths) {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as SchemaSnapshot;

      if (parsed && Array.isArray(parsed.tables) && Array.isArray(parsed.columns)) {
        return parsed;
      }
    } catch {
      // ignore and continue
    }
  }

  return null;
}