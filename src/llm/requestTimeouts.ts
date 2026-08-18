/**
 * Per-request and transport timeouts, shared by every provider adapter.
 *
 * Extracted from `anthropicAdapter.ts` (ledger item 57) once a second provider needed the same
 * two-layer structure. It lives in its own module rather than being imported across adapters so
 * that loading the OpenAI adapter does not pull in the Anthropic SDK; `anthropicAdapter.ts`
 * re-exports `deriveRequestTimeoutMs` and `TRANSPORT_TIMEOUT_MS` so existing import paths and
 * `anthropicAdapter.timeout.test.ts` are unchanged.
 *
 * The vendor rate below is Anthropic's published figure. Applying it to OpenAI is a deliberate
 * borrow: OpenAI publishes no equivalent, its SDK carries no analogous guard, and `gpt-5.x` shares
 * the same 128,000-token output ceiling — so the derivation's domain maps cleanly and the result is
 * a conservative deadline, not a claim about OpenAI's generation rate.
 */

import { Agent } from "undici";

// ── Request duration ─────────────────────────────────────────────────────────
//
// A non-streaming request holds one connection for the whole generation with no
// bytes coming back, so how long it may take is a function of how much output it
// may produce. Anthropic's own SDK models that as 128k output tokens ≈ 60 minutes
// (client.js calculateNonstreamingTimeout) — reuse the vendor's number rather than
// inventing one.

/** Vendor's implied generation cost per unit of output budget: 60 min / 128k tokens. */
const VENDOR_MS_PER_MAX_TOKEN = (60 * 60 * 1000) / 128_000;

/**
 * The vendor figure is an ESTIMATE the SDK uses as a threshold ("is this long
 * enough that you should be streaming?"), not a deadline. Used raw it would abort a
 * request that actually fills its budget at exactly its expected completion time.
 * Doubling turns the estimate into a deadline a full-budget request clears.
 */
const REQUEST_TIMEOUT_MARGIN = 2;

/** Floor: the SDK's own DEFAULT_TIMEOUT, so small requests behave exactly as before. */
export const MIN_REQUEST_TIMEOUT_MS = 600_000;

/** Ceiling: the SDK's own maxTime for a single request.
 *  Budgets above ~64k land here rather than getting the full margin, which is
 *  acceptable — the vendor's implied ~35 tokens/sec is conservative against observed
 *  rates, so 60 minutes still carries real headroom at 128k. */
export const MAX_REQUEST_TIMEOUT_MS = 3_600_000;

/**
 * Per-request timeout for a given output budget.
 * Exported for tests: the relationship to TRANSPORT_TIMEOUT_MS is the property that
 * matters, so it is asserted by sweeping this function rather than by comparing
 * literals.
 */
export function deriveRequestTimeoutMs(maxTokens: number | undefined): number {
  const budget = typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 0;
  const expected = Math.ceil(budget * VENDOR_MS_PER_MAX_TOKEN * REQUEST_TIMEOUT_MARGIN);
  return Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, expected));
}

/**
 * Transport ceiling, kept strictly above every derivable request timeout so the
 * SDK's AbortController is the single authority and undici never cuts first.
 *
 * undici defaults both timers to 300s. For a non-streaming request `headersTimeout`
 * is a hard, non-refreshing deadline covering the entire generation — which made the
 * real ceiling 5 minutes, half of what the SDK was configured for. Deliberately not
 * 0: disabling the timers would let a genuinely dead connection hang for the full
 * SDK timeout, so the transport keeps a backstop that simply never fires first.
 */
// @unverified-probe(transport:long-request) the derivation and the dispatcher are
// unit-tested, but no live call has yet been observed running past ten minutes and
// completing. Anthropic's own SDK treats non-streaming beyond ten minutes as
// unsupported, so whether the vendor's edge holds a silent connection for thirty
// minutes is not something Zone's configuration can establish on its own.
export const TRANSPORT_TIMEOUT_MS = MAX_REQUEST_TIMEOUT_MS + 5 * 60 * 1000;

/** Shared across clients: one connection pool per process, not one per adapter. */
export const zoneDispatcher = new Agent({
  headersTimeout: TRANSPORT_TIMEOUT_MS,
  bodyTimeout: TRANSPORT_TIMEOUT_MS,
});

