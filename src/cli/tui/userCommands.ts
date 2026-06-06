import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";

export interface UserCommand {
  name: string;        // "/refactor" — the slash-prefixed command name
  description: string; // from frontmatter description: or first body line (≤60 chars)
  body: string;        // verbatim task prompt (trimmed), injected on execution
}

/** Relative path under repoPath where command files live. */
export const COMMANDS_RELATIVE_DIR = path.join(".zone", "commands");

const MAX_USER_COMMANDS = 50;
const MAX_BODY_BYTES    = 16 * 1024; // 16 KB per file
// Names derived from lowercase basename must match this pattern.
const VALID_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// ─── test injection seam (mirrors diskSessions.ts) ───────────────────────────

let _commandsDirOverride: string | null = null;

/** For test isolation only — redirect where commands are loaded from. */
export function _setCommandsDirForTest(p: string | null): void {
  _commandsDirOverride = p;
}

function resolveCommandsDir(repoPath: string): string {
  return _commandsDirOverride ?? path.join(repoPath, COMMANDS_RELATIVE_DIR);
}

// ─── parsing helpers ──────────────────────────────────────────────────────────

/**
 * Lightweight frontmatter parser — reads an optional leading `---` … `---` block
 * and extracts the `description:` key. No yaml dependency.
 */
function parseFrontmatter(text: string): { description?: string; body: string } {
  if (!text.startsWith("---")) return { body: text };
  const closeIdx = text.indexOf("\n---", 3);
  if (closeIdx === -1) return { body: text }; // unclosed fence — treat as no frontmatter
  const fm   = text.slice(3, closeIdx);
  const body = text.slice(closeIdx + 4).replace(/^\r?\n/, ""); // skip \n--- + following newline
  let description: string | undefined;
  for (const line of fm.split(/\r?\n/)) {
    const m = /^description:\s*(.+)$/.exec(line.trim());
    if (m) { description = m[1]!.trim(); break; }
  }
  return { description, body };
}

function descriptionFallback(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t.length > 60 ? t.slice(0, 57) + "…" : t;
  }
  return "";
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Load user-defined slash commands from `<repoPath>/.zone/commands/*.md`.
 *
 * Never throws — any per-file error silently skips that file.
 * Missing directory returns [].
 *
 * Built-in collision dedup happens at the Composer merge step (Phase 3),
 * keeping this module dependency-free and purely testable.
 */
export async function loadUserCommands(repoPath: string): Promise<UserCommand[]> {
  if (!repoPath || typeof repoPath !== "string") return [];
  const dir = resolveCommandsDir(repoPath);

  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // ENOENT (dir doesn't exist yet) or any other error → silently return []
    return [];
  }

  const mdFiles = entries
    .filter(e => e.isFile() && e.name.endsWith(".md"))
    .slice(0, MAX_USER_COMMANDS) // cap before issuing stat calls
    .map(e => e.name);

  const commands: UserCommand[] = [];
  const seen = new Set<string>();

  for (const filename of mdFiles) {
    try {
      const basename = path.basename(filename, ".md").toLowerCase();
      if (!VALID_NAME_RE.test(basename)) continue; // bad charset — skip

      const name = `/${basename}`;
      if (seen.has(name)) continue; // dedupe within the user set

      const filePath = path.join(dir, filename);
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_BODY_BYTES) continue; // oversized — skip

      const text = await fs.readFile(filePath, "utf8");
      const { description, body } = parseFrontmatter(text);
      const trimmedBody = body.trim();
      if (!trimmedBody) continue; // empty body — skip

      seen.add(name);
      commands.push({
        name,
        description: description ?? descriptionFallback(trimmedBody),
        body: trimmedBody,
      });
    } catch {
      // per-file error → skip; never propagate
    }
  }

  return commands;
}
