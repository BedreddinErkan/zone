import OpenAI from "openai";

export function createOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing in .env");
  }

  return new OpenAI({ apiKey });
}

export function getModelName(): string {
return process.env.OPENAI_MODEL || "gpt-4o-mini";}