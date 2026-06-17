import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadCliConfig, applyDiskKeyFallbacks } from "../cli/config.js";
import { withRequestContext } from "../llm/openaiContext.js";
import { runInvestigationFlow } from "../llm/investigationFlow.js";
import { ensureZoneGitignore } from "../core/ensureZoneGitignore.js";

const MEMORY_PATH_RELATIVE = join(".zone", "memory.md");

const INIT_PROMPT = `You are analyzing a software project to produce a structured project memory file.

Read these files in order:
1. Use list_files to get the top-level directory structure (depth 1).
2. Read README.md if present, then package.json / Cargo.toml / go.mod / pyproject.toml — whichever exists.
3. Read tsconfig.json, vitest.config.*, vite.config.*, or equivalent build/test config if present.
4. Read the main entry/dispatch file (e.g. src/cli/index.ts, src/index.ts, main.py, main.go) and 1-2 shared utility modules for cross-cutting concerns (config loading, auth, persistence, path handling, error mapping — for LLM-agent projects these include key/provider/model resolution and client/adapter factory). Choose the files with the highest architectural density.
5. Use search_in_files ONCE to find where the shared module identified in step 4 is imported across the codebase (search for its module name or exported function in src/**/*.ts or equivalent). Record the top 2-3 call sites for the Shared helpers section.

Produce a SINGLE markdown response with EXACTLY these seven sections and no other content:

## Project
Project name (from package.json / Cargo.toml / etc.) and a one-sentence description.

## Stack
Language(s), framework(s), runtime version, package manager.

## Commands
install, build, test, lint, run/dev commands (extracted from package.json scripts or Makefile).

## Entry points
Main binary / server entry / CLI command.

## Shared helpers
Key modules for cross-cutting concerns in this project (config loading, auth, persistence, path handling, error mapping; adapt to what exists). For each: \`module-path → exported-function\` — what callers MUST use it for. State the rule: use these helpers; never inline the concern they encapsulate.

## Invariants & gotchas
3-5 non-obvious constraints extracted from the build config and entry files: build/run quirks (e.g. "CLI runs from dist/ — rebuild after editing src/"; "use .js import specifiers in ESM"), path/cache traps, atomic-write rules, version constraints, test isolation requirements.

## Verification gates
Commands that must pass before a change is "done". Extract from package.json scripts, Makefile, or CI config.

STRICT RULES:
- Base ALL content ONLY on files you actually read. No guessing.
- Total response must be under 100 lines.
- No preamble, no conclusion, no extra commentary outside the seven sections.`;

export function stripTrailingCodeBlock(text: string): string {
  return text.replace(/\n```[a-zA-Z]*\n((?:(?!```)[\s\S])*)\n```\s*$/, "");
}

export async function runInitFlow(
  cwd: string,
  onProgress?: (msg: string) => void,
  abortSignal?: AbortSignal,
): Promise<{ ok: boolean; message: string; costUsd?: number }> {
  const memoryPath = join(cwd, MEMORY_PATH_RELATIVE);

  try {
    const s = await fs.stat(memoryPath);
    if (s.size > 0) {
      return { ok: false, message: ".zone/memory.md already exists. Delete or move it first to re-init." };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, message: `init: cannot check memory.md: ${(err as Error).message}` };
    }
  }

  onProgress?.("Analyzing repo…");

  let chatResponse: string;
  let initCostUsd = 0;
  try {
    const config = loadCliConfig({ repo: cwd });
    await applyDiskKeyFallbacks(config);
    const apiKey = config.provider === "openai" ? config.openaiApiKey : config.anthropicApiKey;
    const result = await withRequestContext(
      {
        userApiKey: apiKey,
        provider: config.provider,
        modelOverride: { high: config.model, standard: config.model },
      },
      () =>
        runInvestigationFlow({
          task: INIT_PROMPT,
          repoPath: cwd,
          runId: randomUUID(),
          userApiKey: apiKey,
          provider: config.provider,
          abortSignal,
          suppressOutputFormat: true,
        }),
    );
    chatResponse = result.chatResponse;
    initCostUsd = result.costUsd;
  } catch (err) {
    return { ok: false, message: `init: investigation failed: ${(err as Error).message}` };
  }

  onProgress?.("Creating .zone/memory.md…");

  try {
    await fs.mkdir(join(cwd, ".zone"), { recursive: true });
    const cleaned = stripTrailingCodeBlock(chatResponse).trimEnd();
    const content = `<!-- ZONE_INIT_BEGIN -->\n${cleaned}\n<!-- ZONE_INIT_END -->\n`;
    await fs.writeFile(memoryPath, content, "utf-8");
    const lines = chatResponse.split("\n").length;
    const suffix = lines < 20 ? " Response was short — review and expand .zone/memory.md manually." : "";
    await ensureZoneGitignore(cwd);
    const msg = `Created .zone/memory.md (${lines} lines). Use /memory to view, or edit directly.${suffix}`;
    onProgress?.(msg);
    return { ok: true, message: msg, costUsd: initCostUsd };
  } catch (err) {
    return { ok: false, message: `init: failed to write memory.md: ${(err as Error).message}` };
  }
}
