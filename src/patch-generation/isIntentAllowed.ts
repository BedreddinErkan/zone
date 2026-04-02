import type { PatchIntent } from "./classifyPatchIntent.js";

export type PatchGenerationStrategy = "blocked" | "restricted" | "safe";

const ALLOWED_INTENTS_BY_STRATEGY: Record<
  PatchGenerationStrategy,
  readonly PatchIntent[]
> = {
  blocked: [],
  restricted: ["rename_symbol", "add_comment", "safe_replace"],
  safe: ["rename_symbol", "update_import", "add_comment", "safe_replace"]
};

export function isIntentAllowed(
  intent: PatchIntent,
  strategy: PatchGenerationStrategy
): boolean {
  if (intent === "unknown") {
    return false;
  }

  return ALLOWED_INTENTS_BY_STRATEGY[strategy].includes(intent);
}