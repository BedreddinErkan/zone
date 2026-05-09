import { extractResponsesApiOutputText, getModelName } from "./openaiClient.js";
import { createLLMClient } from "./factory.js";
import { getRequestContext } from "./openaiContext.js";
import { debugLog } from "../utils/logger.js";

export type ZoneMessageType = "patch_request" | "question" | "discussion";
export type ZoneLegacyIntent = "execute" | "chat" | "investigation";

export function shouldUseInvestigationMode(
  task: string,
  messageType: ZoneMessageType
): boolean {
  if (messageType === "patch_request") return false;
  const normalizedTask = String(task || "").trim();
  if (!normalizedTask) return false;
  const lower = normalizedTask.toLowerCase();

  if (/^(?:hi|hello|hey|thanks|thank you)\b/.test(lower)) return false;
  if (
    /\b(?:best|better|recommend|opinion|approach|tradeoff|vs|versus)\b/.test(lower) &&
    !/\b(?:codebase|repo|repository|file|function|class|component|endpoint|call\s*site|reference|import|export)\b/.test(lower)
  ) {
    return false;
  }

  const hasPathSignal =
    /(?:^|\s)(?:src|app|pages|lib|server|api|components|tests?|packages?)\/[^\s]+/i.test(normalizedTask) ||
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|py|go|rs|java|kt|rb|php)\b/i.test(normalizedTask);
  const hasIdentifierSignal =
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\s*\(/.test(normalizedTask) ||
    /\b[a-z]+[A-Z][A-Za-z0-9_$]*\b/.test(normalizedTask) ||
    /\b[A-Z][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/.test(normalizedTask) ||
    /\b[a-z]+_[a-z0-9_]+\b/.test(normalizedTask);
  const asksForCodebaseFacts =
    /\b(?:what does|where is|where are|which files?|who calls|what calls|find usages?|uses?|used by|references?|call sites?|return|returns|flow|end to end|how does|how do|trace|explain)\b/i.test(
      normalizedTask
    );
  const explicitCodebaseQuestion =
    /\b(?:codebase|repo|repository|source|implementation|function|class|component|endpoint|module|import|export|caller|callee)\b/i.test(
      normalizedTask
    );

  return (
    hasPathSignal ||
    (asksForCodebaseFacts && (hasIdentifierSignal || explicitCodebaseQuestion))
  );
}

function fallbackMessageType(task: string): ZoneMessageType {
  const normalizedTask = String(task || "").trim();
  if (!normalizedTask) return "question";

  if (
    /\b(?:fix|add|remove|delete|refactor|implement|update|change|rename|create|modify|insert|replace)\b/i.test(
      normalizedTask
    )
  ) {
    return "patch_request";
  }

  if (
    /\b(?:should|better|best|recommend|opinion|approach|tradeoff|vs|versus)\b/i.test(
      normalizedTask
    )
  ) {
    return "discussion";
  }

  return "question";
}

function parseMessageTypeJson(raw: string): ZoneMessageType | null {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    if (
      parsed?.type === "patch_request" ||
      parsed?.type === "question" ||
      parsed?.type === "discussion"
    ) {
      return parsed.type;
    }
  } catch {
    // fall through
  }

  const direct = trimmed.toLowerCase();
  if (
    direct === "patch_request" ||
    direct === "question" ||
    direct === "discussion"
  ) {
    return direct;
  }

  const match = trimmed.match(
    /"type"\s*:\s*"(patch_request|question|discussion)"/i
  );
  if (match?.[1]) {
    return match[1].toLowerCase() as ZoneMessageType;
  }

  return null;
}

export async function detectMessageType(
  task: string,
  userApiKey?: string,
): Promise<ZoneMessageType> {
  const normalizedTask = typeof task === "string" ? task.trim() : "";
  if (!normalizedTask) return "question";

  try {
    const client = createLLMClient({ apiKey: userApiKey });
    const prompt = [
      "Classify this user message into one of:",
      "- patch_request: user wants code to be modified",
      "- question: user wants information about existing code",
      "- discussion: user wants advice/recommendations",
      "",
      'Respond with JSON: { "type": "patch_request|question|discussion" }',
      "",
      `Message: ${normalizedTask}`,
    ].join("\n");

    const ctx = getRequestContext();
    const response = await client.createChatCompletion({
      model: getModelName("standard", client.provider, ctx?.modelOverride),
      temperature: 0,
      max_tokens: 50,
      messages: [{ role: "user", content: prompt }],
    });

    const extraction = extractResponsesApiOutputText(response);
    const raw = extraction.ok ? extraction.text : "";
    const messageType = parseMessageTypeJson(raw) ?? fallbackMessageType(normalizedTask);

    debugLog("[zone-intent-classify]", {
      taskPreview: normalizedTask.slice(0, 120),
      raw: raw.slice(0, 120),
      messageType,
    });

    return messageType;
  } catch (error) {
    const messageType = fallbackMessageType(normalizedTask);
    debugLog("[zone-intent-classify]", {
      taskPreview: normalizedTask.slice(0, 120),
      error: error instanceof Error ? error.message : String(error),
      messageType,
      fallback: true,
    });
    return messageType;
  }
}

export async function detectIntent(
  task: string,
  userApiKey?: string,
): Promise<ZoneLegacyIntent> {
  const messageType = await detectMessageType(task, userApiKey);
  if (shouldUseInvestigationMode(task, messageType)) return "investigation";
  return messageType === "patch_request" ? "execute" : "chat";
}
