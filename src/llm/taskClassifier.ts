import { createLLMClient } from "./factory.js";
import { extractResponsesApiOutputText } from "./openaiClient.js";
import { extractUsage } from "./recordingClient.js";
import { getRequestContext } from "./openaiContext.js";
import { totalCost, type ProviderName } from "../usage/pricing.js";
import { log, errorLog } from "../utils/logger.js";

export type TaskTier = "simple" | "medium" | "complex";

export interface TaskClassification {
  tier: TaskTier;
  estimatedFiles: number;
  estimatedIterations: number;
  needsSubagent: boolean;
  /** 0.0-1.0 — model self-reported. Below CONFIDENCE_THRESHOLD triggers fallback. */
  confidence: number;
  reasoning?: string;
  classifierCostUsd: number;
  classifierLatencyMs: number;
  classifierModel: string;
  fallbackUsed?: boolean;
}

export interface ClassifyTaskOptions {
  provider?: "openai" | "anthropic";
  userApiKey?: string;
  skipCache?: boolean;
  /** Test hook: override the 5s timeout. */
  timeoutMs?: number;
}

const CLASSIFIER_SYSTEM_PROMPT = `You classify coding tasks for a tier-based execution system.

Tier definitions:
- "simple":  ≤2 files, ≤10 iterations, NO subagent dispatch needed.
             Examples: comment add, single-file rename, small typo fix, single CSS change.
- "medium":  3-8 files, 10-25 iterations, MAY need subagent (max 1).
             Examples: multi-file refactor, new feature in 1-2 modules, config migration.
- "complex": 9+ files, 25+ iterations, MAY need subagent (max 3).
             Examples: architecture change, large refactor, cross-cutting concern.

Be conservative: if uncertain, classify UP (medium > simple, complex > medium).

Output ONLY valid JSON:
{
  "tier": "simple" | "medium" | "complex",
  "estimatedFiles": <integer>,
  "estimatedIterations": <integer>,
  "needsSubagent": <boolean>,
  "confidence": <0.0-1.0>,
  "reasoning": "<one short sentence>"
}`;

const DEFAULT_TIMEOUT_MS = 5000;
const CONFIDENCE_THRESHOLD = 0.5;
const MAX_OUTPUT_TOKENS = 200;

const classificationCache = new Map<string, TaskClassification>();

function hashTask(taskDescription: string): string {
  // Deterministic djb2 hash → base36 string. Produces stable cache keys
  // independent of Node version (no built-in crypto dependency).
  let hash = 5381;
  for (let i = 0; i < taskDescription.length; i += 1) {
    hash = ((hash << 5) + hash) ^ taskDescription.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function pickClassifierModel(provider: "openai" | "anthropic"): string {
  // Use the cheapest registered model per provider. claude-haiku-4-5 ~$1/Mtok
  // input, gpt-5.4-mini ~$0.75/Mtok input — well below $0.0005/classification
  // for prompts under ~500 tokens.
  return provider === "anthropic" ? "claude-haiku-4-5" : "gpt-5.4-mini";
}

interface ParsedClassifierResponse {
  tier: TaskTier;
  estimatedFiles: number;
  estimatedIterations: number;
  needsSubagent: boolean;
  confidence: number;
  reasoning?: string;
}

function parseClassifierResponse(text: string): ParsedClassifierResponse {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  if (!cleaned) {
    throw new Error("empty classifier response");
  }
  const parsed = JSON.parse(cleaned);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("classifier response is not an object");
  }
  if (!["simple", "medium", "complex"].includes(parsed.tier)) {
    throw new Error(`invalid tier: ${String(parsed.tier)}`);
  }
  return {
    tier: parsed.tier as TaskTier,
    estimatedFiles: Math.max(1, Math.floor(Number(parsed.estimatedFiles) || 1)),
    estimatedIterations: Math.max(1, Math.floor(Number(parsed.estimatedIterations) || 10)),
    needsSubagent: Boolean(parsed.needsSubagent),
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    reasoning:
      typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : undefined,
  };
}

function buildFallback(
  model: string,
  costUsd: number,
  startTime: number,
  reason: string
): TaskClassification {
  return {
    tier: "medium",
    estimatedFiles: 5,
    estimatedIterations: 15,
    needsSubagent: false,
    confidence: 0,
    reasoning: `classifier fallback: ${reason}`,
    classifierCostUsd: costUsd,
    classifierLatencyMs: Date.now() - startTime,
    classifierModel: model,
    fallbackUsed: true,
  };
}

function computeResponseCost(
  response: unknown,
  provider: "openai" | "anthropic",
  fallbackModel: string
): number {
  const usage = extractUsage((response as { usage?: unknown })?.usage);
  if (!usage) return 0;
  const providerName: ProviderName = provider === "anthropic" ? "anthropic" : "openai";
  const responseModel =
    (response as { model?: string })?.model || fallbackModel;
  return totalCost(providerName, responseModel, {
    input_uncached: usage.input_uncached,
    cache_write: usage.cache_write,
    cache_read: usage.cache_read,
    output: usage.output,
  });
}

export async function classifyTask(
  taskDescription: string,
  options: ClassifyTaskOptions = {}
): Promise<TaskClassification> {
  const startTime = Date.now();
  const normalized = String(taskDescription || "").trim();
  const cacheKey = hashTask(normalized);

  if (!options.skipCache && classificationCache.has(cacheKey)) {
    return classificationCache.get(cacheKey)!;
  }

  const ctx = getRequestContext();
  const provider = options.provider ?? ctx?.provider ?? "openai";
  const model = pickClassifierModel(provider);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let costUsd = 0;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const client = createLLMClient({ apiKey: options.userApiKey, provider });

    const response = await Promise.race([
      client.createChatCompletion({
        model,
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: `Task: ${normalized}\n\nClassify this task.` },
        ],
      }),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("classifier timeout")),
          timeoutMs
        );
      }),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    costUsd = computeResponseCost(response, provider, model);

    const extraction = extractResponsesApiOutputText(response);
    if (!extraction.ok) {
      throw new Error(`text extraction failed: ${extraction.reason}`);
    }

    const parsed = parseClassifierResponse(extraction.text);

    if (parsed.confidence < CONFIDENCE_THRESHOLD) {
      const fallback = buildFallback(model, costUsd, startTime, "low confidence");
      classificationCache.set(cacheKey, fallback);
      log(
        "[zone-task-classified]",
        JSON.stringify({
          taskHash: cacheKey,
          tier: fallback.tier,
          confidence: parsed.confidence,
          rawTier: parsed.tier,
          classifierModel: model,
          classifierCostUsd: costUsd,
          classifierLatencyMs: fallback.classifierLatencyMs,
          fallbackUsed: true,
          fallbackReason: "low_confidence",
        })
      );
      return fallback;
    }

    const classification: TaskClassification = {
      ...parsed,
      classifierCostUsd: costUsd,
      classifierLatencyMs: Date.now() - startTime,
      classifierModel: model,
    };

    classificationCache.set(cacheKey, classification);

    log(
      "[zone-task-classified]",
      JSON.stringify({
        taskHash: cacheKey,
        tier: classification.tier,
        estimatedFiles: classification.estimatedFiles,
        estimatedIterations: classification.estimatedIterations,
        needsSubagent: classification.needsSubagent,
        confidence: classification.confidence,
        classifierModel: classification.classifierModel,
        classifierCostUsd: classification.classifierCostUsd,
        classifierLatencyMs: classification.classifierLatencyMs,
      })
    );

    return classification;
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : String(err);
    errorLog(
      "[zone-task-classifier-failure]",
      JSON.stringify({
        error: message,
        taskHash: cacheKey,
        classifierModel: model,
      })
    );
    const fallback = buildFallback(model, costUsd, startTime, message);
    log(
      "[zone-task-classified]",
      JSON.stringify({
        taskHash: cacheKey,
        tier: fallback.tier,
        confidence: 0,
        classifierModel: model,
        classifierCostUsd: costUsd,
        classifierLatencyMs: fallback.classifierLatencyMs,
        fallbackUsed: true,
        fallbackReason: "error",
      })
    );
    return fallback;
  }
}

export function clearClassificationCache(): void {
  classificationCache.clear();
}
