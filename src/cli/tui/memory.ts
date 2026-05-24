import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { Dispatch } from "react";
import type { StoreAction } from "./store.js";
import { MEMORY_WARN_THRESHOLD_BYTES } from "../../memory/constants.js";

export async function readMemoryAndShow(cwd: string, dispatch: Dispatch<StoreAction>): Promise<void> {
  const memPath = join(cwd, ".zone", "memory.md");
  let content: string;
  try {
    content = await fs.readFile(memPath, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") {
      dispatch({ type: "USER_PROMPT", text: "No .zone/memory.md found. Run /init to scaffold one." });
    } else {
      dispatch({ type: "USER_PROMPT", text: `Error reading memory: ${String(e?.message ?? e)}` });
    }
    return;
  }
  const lines = content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");
  const parts: string[] = [
    `── .zone/memory.md (${lines} lines · ${(bytes / 1024).toFixed(1)}K) ──`,
    content,
  ];
  if (bytes > MEMORY_WARN_THRESHOLD_BYTES) {
    parts.push("⚠️  Memory exceeds 40K chars; consider trimming.");
  }
  dispatch({ type: "USER_PROMPT", text: parts.join("\n\n") });
}
