import path from "node:path";
import { ensureDir, fileExists, readTextFile, writeTextFile } from "../utils/files.js";

export async function backupFile(
  originalPath: string,
  backupRoot: string
): Promise<string | null> {
  const exists = await fileExists(originalPath);

  if (!exists) {
    return null;
  }

  const content = await readTextFile(originalPath);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = path.basename(originalPath);
  const backupDir = path.join(backupRoot, timestamp);

  await ensureDir(backupDir);

  const backupPath = path.join(backupDir, fileName);
  await writeTextFile(backupPath, content);

  return backupPath;
}