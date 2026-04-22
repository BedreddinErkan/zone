import OpenAI from "openai";

export type ZoneInferenceMode = "hosted" | "local";

export function getInferenceMode(): ZoneInferenceMode {
  const explicitMode = (process.env.ZONE_INFERENCE_MODE || "")
    .trim()
    .toLowerCase();

  if (explicitMode === "hosted" || explicitMode === "local") {
    return explicitMode;
  }

  if (process.env.VITEST === "true") {
    return "local";
  }

  const apiKey =
    typeof process.env.OPENAI_API_KEY === "string"
      ? process.env.OPENAI_API_KEY.trim()
      : "";

  return apiKey ? "local" : "hosted";
}

export function getHostedInferenceBaseUrl(): string {
  const configuredBaseUrl =
    typeof process.env.ZONE_API_BASE_URL === "string"
      ? process.env.ZONE_API_BASE_URL.trim()
      : "";

  return (configuredBaseUrl || "https://zonecli.dev").replace(/\/+$/, "");
}

export function createOpenAIClient(userApiKey?: string): OpenAI {
  const trimmedUserApiKey =
    typeof userApiKey === "string" && userApiKey.trim()
      ? userApiKey.trim()
      : "";
  const mode = getInferenceMode();
  const apiKey = trimmedUserApiKey || process.env.OPENAI_API_KEY;

  console.log(`[zone] openai key source=${trimmedUserApiKey ? "user" : "env"} mode=${mode}`);

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing for local inference mode.");
  }

  return new OpenAI({ apiKey });
}

export type ZoneModelTier = "high" | "standard";

export function getModelName(tier: ZoneModelTier = "standard"): string {
  if (tier === "high") {
    return process.env.ZONE_LLM_MODEL_HIGH ?? process.env.OPENAI_MODEL ?? "gpt-4o";
  }
  return process.env.ZONE_LLM_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
}
