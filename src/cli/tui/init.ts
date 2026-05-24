import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Dispatch } from "react";
import type { StoreAction } from "./store.js";
import { loadDiskKeys } from "../../api/diskKeys.js";
import { runInvestigationFlow } from "../../llm/investigationFlow.js";

const MEMORY_PATH_RELATIVE = join(".zone", "memory.md");

const INIT_PROMPT = `You are analyzing a software project to produce a structured project memory file.

Read these files in order:
1. Use list_files to get the top-level directory structure (depth 1).
2. Read README.md if present, then package.json / Cargo.toml / go.mod / pyproject.toml — whichever exists.
3. Read tsconfig.json, vitest.config.*, vite.config.*, or equivalent build/test config if present.
4. Sample 3 representative source files to infer conventions.

Produce a SINGLE markdown response with EXACTLY these six sections and no other content:

## Project
Project name (from package.json / Cargo.toml / etc.) and a one-sentence description.

## Stack
Language(s), framework(s), runtime version, package manager.

## Layout
3–7 top-level directories and their purpose (one per line, format: \`dir/\` — purpose).

## Commands
install, build, test, lint, run/dev commands (extracted from package.json scripts or Makefile).

## Conventions
3–5 notable patterns: testing approach, file naming, module organization.

## Entry points
Main binary / server entry / CLI command.

STRICT RULES:
- Base ALL content ONLY on files you actually read. No guessing.
- Total response must be under 80 lines.
- No preamble, no conclusion, no extra commentary outside the six sections.`;

export async function runInit(cwd: string, dispatch: Dispatch<StoreAction>): Promise<void> {
  const memoryPath = join(cwd, MEMORY_PATH_RELATIVE);

  // Existence check — refuse if non-empty
  try {
    const s = await fs.stat(memoryPath);
    if (s.size > 0) {
      dispatch({ type: "USER_PROMPT", text: ".zone/memory.md already exists. Delete or move it first to re-init." });
      return;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      dispatch({ type: "USER_PROMPT", text: `init: cannot check memory.md: ${(err as Error).message}` });
      return;
    }
    // ENOENT — file absent, proceed
  }

  dispatch({ type: "USER_PROMPT", text: "Analyzing repo…" });

  let chatResponse: string;
  try {
    const diskKeys = await loadDiskKeys(cwd);
    const apiKey = diskKeys.keys.find(k => k.provider === "anthropic")?.key ?? process.env.ANTHROPIC_API_KEY;
    const result = await runInvestigationFlow({
      task: INIT_PROMPT,
      repoPath: cwd,
      runId: randomUUID(),
      userApiKey: apiKey,
    });
    chatResponse = result.chatResponse;
  } catch (err) {
    dispatch({ type: "USER_PROMPT", text: `init: investigation failed: ${(err as Error).message}` });
    return;
  }

  dispatch({ type: "USER_PROMPT", text: "Creating .zone/memory.md…" });

  try {
    await fs.mkdir(join(cwd, ".zone"), { recursive: true });
    const content = `<!-- ZONE_INIT_BEGIN -->\n${chatResponse.trimEnd()}\n<!-- ZONE_INIT_END -->\n`;
    await fs.writeFile(memoryPath, content, "utf-8");
    const lines = chatResponse.split("\n").length;
    const suffix = lines < 20
      ? " Response was short — review and expand .zone/memory.md manually."
      : "";
    dispatch({ type: "USER_PROMPT", text: `Created .zone/memory.md (${lines} lines). Use /memory to view, or edit directly.${suffix}` });
  } catch (err) {
    dispatch({ type: "USER_PROMPT", text: `init: failed to write memory.md: ${(err as Error).message}` });
  }
}
