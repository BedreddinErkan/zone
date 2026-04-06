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

export function createOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing for local inference mode.");
  }

  return new OpenAI({ apiKey });
}

export function getModelName(): string {
return process.env.OPENAI_MODEL || "gpt-4o-mini";}
