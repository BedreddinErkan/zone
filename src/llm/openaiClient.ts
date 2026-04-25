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

export type ZoneResponsesTextExtraction =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: string;
      refusal?: string;
      incomplete?: string;
      error?: string;
    };

function safeString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function pushText(parts: string[], value: unknown): void {
  const s = safeString(value);
  if (s?.trim()) parts.push(s.trim());
}

function collectFromContentArray(parts: string[], content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    const t = b.type;
    if (t === "output_text" || t === "text" || t === "input_text") {
      pushText(parts, b.text);
    }
  }
}

/**
 * Best-effort extraction of user-visible model text from OpenAI Responses API
 * (and minimal chat-completions) payloads.
 */
export function extractResponsesApiOutputText(
  response: unknown
): ZoneResponsesTextExtraction {
  if (response === null || response === undefined) {
    return { ok: false, reason: "null_response" };
  }

  const r = response as Record<string, unknown>;
  const pieces: string[] = [];

  const direct = safeString(r.output_text);
  if (direct?.trim()) {
    pieces.push(direct.trim());
  }

  const choices = r.choices as unknown[] | undefined;
  if (Array.isArray(choices) && choices.length > 0) {
    const ch0 = choices[0] as Record<string, unknown>;
    const msg = ch0.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    if (typeof content === "string") {
      pushText(pieces, content);
    } else if (Array.isArray(content)) {
      collectFromContentArray(pieces, content);
    }
  }

  const output = r.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;

      if (it.type === "message") {
        collectFromContentArray(pieces, it.content);
      }

      if (it.type === "output_text") {
        pushText(pieces, it.text);
      }
    }
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const p of pieces) {
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    deduped.push(t);
  }
  const merged = deduped.join("\n").trim();
  if (merged.length > 0) {
    return { ok: true, text: merged };
  }

  const refusal = r.refusal;
  if (typeof refusal === "string" && refusal.trim()) {
    return { ok: false, reason: "refusal", refusal: refusal.trim() };
  }

  const incomplete = r.incomplete_details ?? r.incompleteDetails;
  if (incomplete !== undefined && incomplete !== null) {
    const incStr =
      typeof incomplete === "string"
        ? incomplete
        : JSON.stringify(incomplete);
    return { ok: false, reason: "incomplete", incomplete: incStr };
  }

  const status = safeString(r.status);
  if (status === "failed" || status === "cancelled" || status === "incomplete") {
    const err = r.error;
    const errStr =
      err !== undefined && err !== null
        ? typeof err === "object"
          ? JSON.stringify(err)
          : String(err)
        : "";
    return {
      ok: false,
      reason: "response_status",
      error: `${status}${errStr ? `:${errStr}` : ""}`,
    };
  }

  return { ok: false, reason: "no_extractable_text" };
}

function collectOutputContentTypes(output: unknown[]): string[] {
  const types: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (typeof it.type === "string") types.push(it.type);
    if (Array.isArray(it.content)) {
      for (const c of it.content) {
        if (c && typeof c === "object" && "type" in c) {
          types.push(String((c as { type: unknown }).type));
        }
      }
    }
  }
  return types;
}

export function logOpenAiResponseDebug(
  response: unknown,
  context: Record<string, unknown> = {}
): void {
  if (response === null || response === undefined) {
    console.log(
      "[zone-openai-response-debug]",
      JSON.stringify({
        ...context,
        nullResponse: true,
      })
    );
    return;
  }

  const r = response as Record<string, unknown>;
  const usage = r.usage;
  const outputText = safeString(r.output_text) ?? "";
  const output = Array.isArray(r.output) ? r.output : [];
  const finishReason =
    safeString(r.finish_reason) ??
    safeString(r.finishReason) ??
    (output[0] && typeof output[0] === "object"
      ? safeString((output[0] as Record<string, unknown>).finish_reason)
      : null);

  const refusalMeta = r.refusal;
  const incompleteDetails = r.incomplete_details ?? r.incompleteDetails;

  console.log(
    "[zone-openai-response-debug]",
    JSON.stringify({
      ...context,
      usage: usage && typeof usage === "object" ? usage : null,
      status: safeString(r.status),
      outputTextLength: outputText.length,
      outputLength: output.length,
      finishReason,
      refusal: refusalMeta,
      incompleteDetails,
      contentTypes: collectOutputContentTypes(output),
    })
  );
}

export function formatResponsesTextExtractionFailure(
  extraction: Extract<ZoneResponsesTextExtraction, { ok: false }>
): string {
  return [
    extraction.reason,
    extraction.refusal,
    extraction.incomplete,
    extraction.error,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function getResponsesApiDiagnosticSnapshot(response: unknown): {
  status: string | null;
  contentTypes: string[];
  outputLength: number;
  outputTextLength: number;
} {
  if (!response || typeof response !== "object") {
    return { status: null, contentTypes: [], outputLength: 0, outputTextLength: 0 };
  }
  const r = response as Record<string, unknown>;
  const output = Array.isArray(r.output) ? r.output : [];
  const outputText = safeString(r.output_text) ?? "";
  return {
    status: safeString(r.status),
    contentTypes: collectOutputContentTypes(output),
    outputLength: output.length,
    outputTextLength: outputText.length,
  };
}

/** Serializable fields from thrown OpenAI / fetch errors. */
export function formatOpenAiThrownErrorPayload(error: unknown): {
  name: string;
  message: string;
  status?: number | string;
  code?: string;
  type?: string;
} {
  if (error instanceof Error) {
    const e = error as Error & {
      status?: number;
      code?: string;
      type?: string;
    };
    return {
      name: e.name,
      message: e.message,
      status: e.status,
      code: typeof e.code === "string" ? e.code : undefined,
      type: typeof e.type === "string" ? e.type : undefined,
    };
  }
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    const status = e.status ?? e.statusCode;
    return {
      name: String(e.name ?? "Error"),
      message: String(e.message ?? JSON.stringify(error)),
      status:
        typeof status === "number" || typeof status === "string" ? status : undefined,
      code: typeof e.code === "string" ? e.code : undefined,
      type: typeof e.type === "string" ? e.type : undefined,
    };
  }
  return { name: "non_object_error", message: String(error) };
}

/**
 * Single-line JSON for empty_model_response (never null — always includes extraction + response shape).
 */
export function buildEmptyModelResponseDetailsLine(input: {
  response: unknown;
  extraction: ZoneResponsesTextExtraction;
  linearReasonWhenExtractionOk: string;
}): string {
  const snap = getResponsesApiDiagnosticSnapshot(input.response);
  const extractionReason = input.extraction.ok
    ? input.linearReasonWhenExtractionOk
    : formatResponsesTextExtractionFailure(
        input.extraction as Extract<ZoneResponsesTextExtraction, { ok: false }>
      );
  return JSON.stringify({
    extractionReason,
    responseStatus: snap.status,
    contentTypes: snap.contentTypes,
    outputLength: snap.outputLength,
    outputTextLength: snap.outputTextLength,
  });
}
