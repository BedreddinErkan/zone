import { extractResponsesApiOutputText, getModelName } from "./openaiClient.js";
import { createLLMClient } from "./factory.js";
import { getRequestContext } from "./openaiContext.js";
import { debugLog } from "../utils/logger.js";

export type ZoneMessageType = "patch_request" | "question" | "discussion";
export type ZoneLegacyIntent = "execute" | "chat" | "investigation";

// Bug Y: multi-language imperative verbs that strongly signal a patch request.
// Turkish is SOV — verb at end (yap, ekle, değiştir). English/Spanish verbs at start.
const PATCH_IMPERATIVE_PATTERN =
  /(?:^|\s|["'`'])(?:fix|add|remove|delete|refactor|implement|update|change|rename|create|modify|insert|replace|patch|edit|append|prepend|set|make|wrap|move|extract|inline|convert|comment\s*out|uncomment)\b|\b(?:yap|ekle|değiştir|degistir|düzelt|duzelt|oluştur|olustur|sil|kaldır|kaldir|güncelle|guncelle|yaz|ekleyiver|değiştiriver|ekleyebilir|taşı|tasi|yeniden\s+adlandır|yeniden\s+adlandir)\b|\b(?:cambiar|cambia|añadir|anadir|añade|anade|agregar|agrega|arreglar|arregla|crear|crea|eliminar|elimina|borrar|borra|modificar|modifica|reemplazar|reemplaza|actualizar|actualiza|renombrar|renombra)\b/i;

// Question-style cues that should NOT be treated as patch requests even if a
// verb appears later (TR question particles "mı/mi/mu/mü", question words).
const NON_IMPERATIVE_QUESTION_PATTERN =
  /\?\s*$|^\s*(?:why|how|what|where|which|when|who|explain|describe|trace|summarize)\b|\b(?:neden|niye|niçin|nicin|nasıl|nasil|hangi|kim|kaç|kac|ne\s+zaman|açıkla|acikla|anlat|özetle|ozetle)\b|\b(?:mı|mi|mu|mü)\?/i;

export function looksLikePatchImperative(task: string): boolean {
  const normalized = String(task || "").trim();
  if (!normalized) return false;
  if (NON_IMPERATIVE_QUESTION_PATTERN.test(normalized)) return false;
  return PATCH_IMPERATIVE_PATTERN.test(normalized);
}

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

  if (shouldPreferQuestionForInformationRequest(normalizedTask)) {
    return "question";
  }

  if (looksLikePatchImperative(normalizedTask)) {
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

function shouldPreferQuestionForInformationRequest(task: string): boolean {
  const normalizedTask = String(task || "").trim();
  if (!normalizedTask) return false;

  const asksToReceiveInformation =
    /^(?:please\s+)?(?:trace|explain|describe|summarize|cover|list|walk\s+through)\b/i.test(
      normalizedTask
    ) ||
    /\b(?:how does|what does|where is|where are|which files?|why does|definitions?|behavior|structure|control flow|usages?|end[- ]to[- ]end|pipeline|file:line references?|line references?)\b/i.test(
      normalizedTask
    );
  if (!asksToReceiveInformation) return false;

  const startsWithCodeChange =
    /^(?:please\s+)?(?:fix|add|remove|delete|refactor|implement|update|change|rename|create|modify|insert|replace)\b/i.test(
      normalizedTask
    );
  const asksForCodeChangeAfterInfo =
    /\b(?:and|then)\s+(?:fix|add|remove|delete|refactor|implement|update|change|rename|create|modify|insert|replace)\b/i.test(
      normalizedTask
    );

  return !startsWithCodeChange && !asksForCodeChangeAfterInfo;
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
      "- patch_request: user wants code to be MODIFIED - add, remove, change, fix, refactor, rename, create",
      '  Examples: "Add a flag to X", "Refactor Y", "Fix the bug in Z", "Rename A to B"',
      "  Strong signals: imperative verbs that change files (add, remove, modify, fix, refactor, create, rename, replace, delete, implement)",
      "- question: user asks ABOUT existing code - definitions, behavior, structure, control flow, usages",
      "  Strong signals: trace, explain, describe, how does, what does, where is, which files, why does, summarize, cover, list, walk through, end-to-end, pipeline",
      '  Examples: "Trace the apply_patch flow", "How does X work", "Which files use Y", "Explain the auth flow", "Cover dispatch + validation + execution"',
      '  IMPORTANT: even if the task lists multiple stages or asks for "exact line references", it remains a question - the deliverable is an explanation, not code changes.',
      "- discussion: user asks for general advice/recommendations not specific to this codebase",
      '  Examples: "How should I structure my project", "What\'s the best way to handle X"',
      "",
      'Tie-break rule: if the task asks the user to RECEIVE information (a description, a trace, a summary, an explanation, a listing), classify as question - even if it uses imperative verbs like "trace", "list", "cover", "summarize". Only classify as patch_request when the deliverable is a CODE CHANGE the user expects to apply.',
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
    const parsedMessageType = parseMessageTypeJson(raw) ?? fallbackMessageType(normalizedTask);
    const preferQuestion = shouldPreferQuestionForInformationRequest(normalizedTask);
    let messageType: ZoneMessageType =
      parsedMessageType === "patch_request" && preferQuestion
        ? "question"
        : parsedMessageType;
    // Bug Y: override LLM when task is clearly patch-imperative (TR/EN/ES verb +
    // not a question). Handles non-English imperatives the classifier misses.
    if (
      messageType !== "patch_request" &&
      !preferQuestion &&
      looksLikePatchImperative(normalizedTask)
    ) {
      messageType = "patch_request";
    }

    debugLog("[zone-intent-classify]", {
      taskPreview: normalizedTask.slice(0, 120),
      raw: raw.slice(0, 120),
      parsedMessageType,
      messageType,
      intent: shouldUseInvestigationMode(normalizedTask, messageType)
        ? "investigation"
        : messageType === "patch_request"
          ? "execute"
          : "chat",
    });

    return messageType;
  } catch (error) {
    const messageType = fallbackMessageType(normalizedTask);
    debugLog("[zone-intent-classify]", {
      taskPreview: normalizedTask.slice(0, 120),
      error: error instanceof Error ? error.message : String(error),
      messageType,
      intent: shouldUseInvestigationMode(normalizedTask, messageType)
        ? "investigation"
        : messageType === "patch_request"
          ? "execute"
          : "chat",
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
  const intent = shouldUseInvestigationMode(task, messageType)
    ? "investigation"
    : messageType === "patch_request"
      ? "execute"
      : "chat";
  debugLog("[zone-intent-classify]", {
    taskPreview: String(task || "").trim().slice(0, 120),
    messageType,
    intent,
  });
  return intent;
}
