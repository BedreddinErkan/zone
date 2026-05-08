import fs from "node:fs/promises";
import path from "node:path";

export interface MemoryEntry {
  date: string; // YYYY-MM-DD
  text: string; // bullet content, no prefix
  raw: string;  // original raw line "- [YYYY-MM-DD] ..."
}

export const MEMORY_MAX_ENTRIES = 20;
export const MEMORY_RELATIVE_PATH = path.join(".zone", "memory.md");

const FILE_HEADER = [
  "# Zone Project Memory",
  "",
  "<!-- Lessons learned during Zone agent sessions in this repo. -->",
  "<!-- Auto-managed by Zone. You can delete entries via Settings → Memory. -->",
  "",
].join("\n");

const ENTRY_LINE_RE = /^-\s+\[(\d{4}-\d{2}-\d{2})\]\s+(.*)$/;

function memoryFilePath(repoPath: string): string {
  return path.join(repoPath, MEMORY_RELATIVE_PATH);
}

function todayUtc(): string {
  // Date-only stamp, UTC. Avoids timezone drift between machines that share
  // the file via git.
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseEntries(raw: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = ENTRY_LINE_RE.exec(line);
    if (!m) continue;
    const [, date, text] = m;
    entries.push({ date: date!, text: text!.trim(), raw: line.trim() });
  }
  return entries;
}

function renderFile(entries: MemoryEntry[]): string {
  const lines: string[] = [FILE_HEADER];
  for (const e of entries) {
    lines.push(`- [${e.date}] ${e.text}`);
  }
  // Trailing newline so editors don't complain.
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

export async function readMemory(repoPath: string): Promise<MemoryEntry[]> {
  if (!repoPath || typeof repoPath !== "string") return [];
  const filePath = memoryFilePath(repoPath);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseEntries(raw);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
}

export async function appendMemory(
  repoPath: string,
  text: string
): Promise<MemoryEntry> {
  if (!repoPath) throw new Error("appendMemory: repoPath is required");
  const trimmed = String(text || "").trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("appendMemory: entry text is empty");

  const existing = await readMemory(repoPath);
  const entry: MemoryEntry = {
    date: todayUtc(),
    text: trimmed,
    raw: `- [${todayUtc()}] ${trimmed}`,
  };
  const next = [...existing, entry];
  // FIFO eviction: keep the most recent N.
  const trimmedList =
    next.length > MEMORY_MAX_ENTRIES
      ? next.slice(next.length - MEMORY_MAX_ENTRIES)
      : next;

  const filePath = memoryFilePath(repoPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, renderFile(trimmedList), "utf8");
  return entry;
}

export async function deleteMemoryEntry(
  repoPath: string,
  index: number
): Promise<boolean> {
  if (!repoPath) return false;
  if (!Number.isInteger(index) || index < 0) return false;
  const existing = await readMemory(repoPath);
  if (index >= existing.length) return false;
  const next = existing.slice();
  next.splice(index, 1);
  const filePath = memoryFilePath(repoPath);
  await fs.writeFile(filePath, renderFile(next), "utf8");
  return true;
}

export function formatMemoryForPrompt(entries: MemoryEntry[]): string {
  if (!entries || entries.length === 0) return "";
  const bullets = entries.map((e) => `- ${e.text}`).join("\n");
  return [
    "## Project Memory",
    "",
    "You have learned the following conventions about this project from previous sessions. Apply them when relevant; if any contradict the current task or seem outdated, prefer the current task.",
    "",
    bullets,
  ].join("\n");
}
