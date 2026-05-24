import { MODEL_CATALOG } from "./models.js";
import type { LLMProvider } from "./types.js";

export type EffortLevel = "low" | "medium" | "high";

export interface ModelEntry {
  id: string;
  displayName: string;
  provider: "anthropic" | "openai";
  supportsEffort: boolean;
  costNote?: string;
}

const EFFORT_SUPPORTED_MODELS = new Set([
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  // claude-haiku-4-5 excluded: does not support extended thinking in Claude 4 series
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  // gpt-5.4-nano, gpt-4o, gpt-4o-mini excluded
]);

function buildModels(): readonly ModelEntry[] {
  const result: ModelEntry[] = [];
  for (const [provider, models] of Object.entries(MODEL_CATALOG) as [LLMProvider, typeof MODEL_CATALOG[LLMProvider]][]) {
    for (const m of models) {
      result.push({
        id: m.id,
        displayName: m.label,
        provider: provider as "anthropic" | "openai",
        supportsEffort: EFFORT_SUPPORTED_MODELS.has(m.id),
        costNote: m.costNote,
      });
    }
  }
  return result;
}

export const USER_FACING_MODELS: readonly ModelEntry[] = buildModels();

export function getProviderForModel(id: string): "anthropic" | "openai" {
  const entry = USER_FACING_MODELS.find((m) => m.id === id);
  return entry?.provider ?? "anthropic";
}

export function supportsEffort(id: string): boolean {
  return EFFORT_SUPPORTED_MODELS.has(id);
}

export function getDefaultModelId(): string {
  return "claude-sonnet-4-6";
}
