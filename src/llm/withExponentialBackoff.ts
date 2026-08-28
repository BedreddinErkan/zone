import {
  APIConnectionError as AnthropicConnectionError,
  APIUserAbortError as AnthropicUserAbortError,
  RateLimitError as AnthropicRateLimitError,
  InternalServerError as AnthropicInternalServerError,
} from "@anthropic-ai/sdk";
import { ProviderRequestError } from "./factory.js";
import {
  APIConnectionError as OpenAIConnectionError,
  APIUserAbortError as OpenAIUserAbortError,
  RateLimitError as OpenAIRateLimitError,
  InternalServerError as OpenAIInternalServerError,
} from "openai";

export interface RetryClassification {
  retryable: boolean;
  retryClass: "5xx" | "429" | "network" | "non_retryable" | "quota_exceeded";
  retryAfterMs?: number;
}

export interface RetryContext {
  runId?: string;
  model?: string;
  provider?: "anthropic" | "openai";
  emit?: (event: string, payload: Record<string, unknown>) => void;
}

export class UpstreamUnavailableError extends Error {
  constructor(public readonly cause: unknown) {
    super("Upstream LLM unavailable after retries exhausted");
    this.name = "UpstreamUnavailableError";
  }
}

const RETRY_CONFIG = {
  general5xx: { initialDelayMs: 1000, multiplier: 3, maxAttempts: 3, jitterPct: 0.25 },
  rateLimit429: { initialDelayMs: 5000, multiplier: 3, maxAttempts: 4, jitterPct: 0.25, honorRetryAfter: true },
  totalBudgetMs: 60_000,
} as const;

function extractRetryAfterMs(err: { headers?: { get?: (name: string) => string | null } }): number | undefined {
  const headers = err.headers;
  if (!headers?.get) return undefined;
  const msHeader = headers.get("retry-after-ms");
  if (msHeader) {
    const ms = parseInt(msHeader, 10);
    if (!isNaN(ms) && ms > 0) return ms;
  }
  const secHeader = headers.get("retry-after");
  if (secHeader) {
    const secs = parseFloat(secHeader);
    if (!isNaN(secs) && secs > 0) return secs * 1000;
    const date = new Date(secHeader);
    if (!isNaN(date.getTime())) {
      const ms = date.getTime() - Date.now();
      if (ms > 0) return ms;
    }
  }
  return undefined;
}

// item 411: OpenAI returns HTTP 429 for two operationally opposite conditions — transient
// rate_limit_exceeded, where backoff is exactly right, and billing/quota exhaustion, which no
// amount of waiting clears. Confirmed against OpenAI's own current docs (fetched live,
// developers.openai.com/api/docs/guides/error-codes), not assumed: `type: "insufficient_quota"`
// is the documented umbrella for every billing-related 429, and `code` names the specific cause
// underneath it (`credit_balance_exhausted`, `organization_spend_limit_exceeded`,
// `project_spend_limit_exceeded`, `organization_usage_limit_exceeded`). Ordinary rate-limiting
// shows no `code` in the docs' own table.
//
// `code`/`type` are UNTYPED strings on the SDK's own APIError (`code: string | null | undefined`,
// `type: string | undefined` — node_modules/openai/src/core/error.ts) — the SDK gives no
// compile-time guarantee of these specific values; this rests on documentation, not a type
// contract, and could not be confirmed against a live call in the session this was written in
// (both provider balances were exhausted). `type` is checked first as the stable, documented
// umbrella — Anthropic's own docs separately warn that error `type`/`code` value sets may expand
// over time, and the same caution applies here — with the known `code` values as a secondary net
// for the shape where `type` might be absent.
//
// Deliberately asymmetric: an unmatched 429 (no type, or a type other than "insufficient_quota")
// is left exactly as it behaves today — retried as "429". A missed match wastes retries (today's
// status quo); a false match would abandon a genuinely transient rate limit with no retry at all,
// which is worse. Scoped to OpenAI only — Anthropic's billing exhaustion is a different status
// (402, `billing_error`) entirely, not a 429, so Anthropic's RateLimitError branch below is
// untouched by this check.
const OPENAI_QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

export function isOpenAIQuotaExhausted(err: unknown): boolean {
  if (!(err instanceof OpenAIRateLimitError)) return false;
  if (err.type === "insufficient_quota") return true;
  return typeof err.code === "string" && OPENAI_QUOTA_CODES.has(err.code);
}

export function classifyError(err: unknown): RetryClassification {
  if (err instanceof ProviderRequestError) {
    return { retryable: false, retryClass: "non_retryable" };
  }
  if (err instanceof AnthropicUserAbortError || err instanceof OpenAIUserAbortError) {
    return { retryable: false, retryClass: "non_retryable" };
  }
  if (isOpenAIQuotaExhausted(err)) {
    return { retryable: false, retryClass: "quota_exceeded" };
  }
  if (err instanceof AnthropicRateLimitError || err instanceof OpenAIRateLimitError) {
    const retryAfterMs = extractRetryAfterMs(err as { headers?: { get?: (name: string) => string | null } });
    return { retryable: true, retryClass: "429", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (err instanceof AnthropicInternalServerError || err instanceof OpenAIInternalServerError) {
    return { retryable: true, retryClass: "5xx" };
  }
  if (err instanceof AnthropicConnectionError || err instanceof OpenAIConnectionError) {
    return { retryable: true, retryClass: "network" };
  }
  // catch-all for any other API error with status >= 500
  const maybeApiErr = err as { status?: number };
  if (typeof maybeApiErr.status === "number" && maybeApiErr.status >= 500) {
    return { retryable: true, retryClass: "5xx" };
  }
  return { retryable: false, retryClass: "non_retryable" };
}

const NARRATION_THRESHOLD_MS = 5_000;

export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  ctx: RetryContext = {},
): Promise<T> {
  const startMs = Date.now();
  let attempt = 0;
  let totalWaitedMs = 0;
  let narrationEmitted = false;

  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const classification = classifyError(err);

      if (!classification.retryable) throw err;

      const config =
        classification.retryClass === "429"
          ? RETRY_CONFIG.rateLimit429
          : RETRY_CONFIG.general5xx;

      if (attempt >= config.maxAttempts) {
        throw new UpstreamUnavailableError(err);
      }

      let delayMs = config.initialDelayMs * Math.pow(config.multiplier, attempt);

      if (
        classification.retryClass === "429" &&
        RETRY_CONFIG.rateLimit429.honorRetryAfter &&
        classification.retryAfterMs !== undefined
      ) {
        delayMs = Math.max(delayMs, classification.retryAfterMs);
      }

      const jitter = (Math.random() * 2 - 1) * config.jitterPct * delayMs;
      delayMs = Math.max(0, delayMs + jitter);

      if (Date.now() + delayMs - startMs > RETRY_CONFIG.totalBudgetMs) {
        throw new UpstreamUnavailableError(err);
      }

      console.warn(
        `[zone-llm-retry-attempt] attempt=${attempt + 1}/${config.maxAttempts} class=${classification.retryClass} delayMs=${Math.round(delayMs)} provider=${ctx.provider ?? "?"} model=${ctx.model ?? "?"} runId=${ctx.runId ?? "?"}`
      );

      // Y.1.6.4: signal first retry for run-level metric tracking.
      if (attempt === 0) {
        ctx.emit?.("zone_llm_retry_started", {
          runId: ctx.runId ?? null,
          provider: ctx.provider ?? null,
          model: ctx.model ?? null,
        });
      }

      // UI.3.c: per-attempt structured event for rich UI display (reuses [zone-llm-retry-attempt] info).
      ctx.emit?.("zone_llm_retry_attempt", {
        runId: ctx.runId ?? null,
        provider: ctx.provider ?? null,
        model: ctx.model ?? null,
        attemptIndex: attempt + 1,
        maxAttempts: config.maxAttempts,
        errorClass: classification.retryClass,
        delayMs: Math.round(delayMs),
      });

      // Y.1.6.3: emit SSE narration ONCE when cumulative wait will exceed 5 s.
      const pendingTotal = totalWaitedMs + delayMs;
      if (!narrationEmitted && pendingTotal > NARRATION_THRESHOLD_MS) {
        narrationEmitted = true;
        ctx.emit?.("llm_retry_in_progress", {
          runId: ctx.runId ?? null,
          model: ctx.model ?? null,
          provider: ctx.provider ?? null,
          attemptIndex: attempt + 1,
          totalWaitedMs: pendingTotal,
          errorClass: classification.retryClass as "5xx" | "429" | "network",
        });
      }

      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      totalWaitedMs += delayMs;
      attempt++;
    }
  }
}
