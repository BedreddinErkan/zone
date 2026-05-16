import { createLLMClient } from "./factory.js";
import {
  extractResponsesApiOutputText,
  formatOpenAiThrownErrorPayload,
} from "./openaiClient.js";
import { extractUsage } from "./recordingClient.js";
import { getRequestContext } from "./openaiContext.js";
import { totalCost, type ProviderName } from "../usage/pricing.js";
import { log } from "../utils/logger.js";

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
             Examples: architecture change, large refactor, cross-cutting concern,
             find-and-modify across N callsites, intentional breaking changes
             that ripple through callers, multi-investigation tasks.

Classification heuristics:
- "find X with N callers/usages" → multi-investigation → MEDIUM or COMPLEX
- "change signature that breaks callers" → cross-cutting → COMPLEX
- "all instances" / "every X" / "across the codebase" → COMPLEX
- "intentional break" / "type errors" / "breaking change" → COMPLEX
- Single file edit with no cross-references → SIMPLE
- Pure cosmetic change (comment, rename in single file) → SIMPLE

COMPLEX tier triggers (any one is sufficient):
- Rename / refactor of a symbol across ≥3 files where its definition +
  imports + call sites all need coordinated updates
- Task wording includes "across all N files" / "every reference" /
  "throughout the codebase" / "in each file" combined with a count ≥3
- An explicit list of 3+ file paths in the task description, all needing
  coordinated edits
- Signature change that ripples through caller files
- Cross-file API contract changes (rename, signature, return type)
  affecting ≥3 consumers

When uncertain between medium and complex, prefer complex for tasks involving:
- "rename" keyword + multi-file scope (≥3 files)
- "import" + "call site" mentioned together (suggests coordinated cross-file edit)
- Explicit file list with ≥4 entries

Counter-examples (stay MEDIUM, not COMPLEX):
- "Add new export to N files" — pure additions don't require coordinated
  FIND/REPLACE across files
- "Rename X to Y in 2 files" — count <3, medium scope

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
/** Confidence gate: classifier outputs below this threshold are overridden to "medium". */
export const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.5;
const MAX_OUTPUT_TOKENS = 200;

const classificationCache = new Map<string, TaskClassification>();

function truncateForLog(value: unknown, maxChars = 600): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (typeof s !== "string") s = String(s);
  return s.length > maxChars ? `${s.slice(0, maxChars)}…[truncated]` : s;
}

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
  if (provider === "anthropic") {
    return process.env.ZONE_CLASSIFIER_MODEL_ANTHROPIC?.trim() || "claude-haiku-4-5";
  }
  return process.env.ZONE_CLASSIFIER_MODEL_OPENAI?.trim() || "gpt-5.4-mini";
}

interface ParsedClassifierResponse {
  tier: TaskTier;
  estimatedFiles: number;
  estimatedIterations: number;
  needsSubagent: boolean;
  confidence: number;
  reasoning?: string;
}

/**
 * Q.8: derive needsSubagent from tier + scope, ignoring the LLM's self-report.
 * The classifier model often returns `needsSubagent: false` for tasks that
 * downstream tiering treats as needing parallel work. Enforcing the rule
 * here closes that gap.
 *
 *   - tier === "complex"                            → always true
 *   - tier === "medium" && estimatedFiles >= 4      → true
 *   - otherwise                                     → respect the LLM's value
 */
function deriveNeedsSubagent(
  tier: TaskTier,
  estimatedFiles: number,
  llmValue: boolean
): boolean {
  if (tier === "complex") return true;
  if (tier === "medium" && estimatedFiles >= 4) return true;
  return llmValue;
}

function parseClassifierResponse(text: string): ParsedClassifierResponse {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  if (!cleaned) {
    throw new Error("empty classifier response");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: extract the first top-level {...} block (handles leading/trailing prose).
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error("no JSON object found in classifier response");
    }
    parsed = JSON.parse(match[0]);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("classifier response is not an object");
  }
  if (!["simple", "medium", "complex"].includes(parsed.tier)) {
    throw new Error(`invalid tier: ${String(parsed.tier)}`);
  }
  const tier = parsed.tier as TaskTier;
  const estimatedFiles = Math.max(1, Math.floor(Number(parsed.estimatedFiles) || 1));
  return {
    tier,
    estimatedFiles,
    estimatedIterations: Math.max(1, Math.floor(Number(parsed.estimatedIterations) || 10)),
    needsSubagent: deriveNeedsSubagent(tier, estimatedFiles, Boolean(parsed.needsSubagent)),
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
  const provider = options.provider ?? ctx?.provider ?? "anthropic";
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
        // gpt-5.x mini / reasoning-style models reject `max_tokens` — they
        // require `max_completion_tokens`. The OpenAI SDK accepts both fields,
        // so prefer the new spelling everywhere this classifier runs.
        max_completion_tokens: MAX_OUTPUT_TOKENS,
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

    if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
      const fallback = buildFallback(model, costUsd, startTime, "low confidence");
      classificationCache.set(cacheKey, fallback);
      if (parsed.tier !== "medium") {
        log(
          "[zone-tier-low-confidence-fallback]",
          JSON.stringify({
            classifierTier: parsed.tier,
            forcedTier: "medium",
            confidence: parsed.confidence,
            threshold: CLASSIFIER_CONFIDENCE_THRESHOLD,
          })
        );
      }
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
    const errPayload = formatOpenAiThrownErrorPayload(err);
    const responseData =
      (err as { response?: { data?: unknown } } | undefined)?.response?.data ??
      (err as { error?: unknown } | undefined)?.error;
    log(
      "[zone-task-classifier-failure]",
      JSON.stringify({
        taskHash: cacheKey,
        classifierModel: model,
        provider,
        name: errPayload.name,
        message: errPayload.message,
        status: errPayload.status,
        code: errPayload.code,
        type: errPayload.type,
        responseData:
          responseData === undefined ? undefined : truncateForLog(responseData),
      })
    );
    const fallback = buildFallback(model, costUsd, startTime, errPayload.message);
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
