import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import { applyMessageCacheBreakpoint2 } from "./cacheControlHelpers.js";
import { readProviderState, selectThinkingReplayIndices } from "./thinkingBlocks.js";
import { supportsEffort, usesAdaptiveThinking, resolveEffortForModel } from "../modelRegistry.js";
import { getMaxOutputTokens, lookupMaxOutputTokens, getCacheMinChars } from "../models.js";
import type { EffortLevel } from "../modelRegistry.js";

// Existing low/medium/high values UNCHANGED. xhigh defensive (Sonnet won't receive it after resolver).
const EFFORT_BUDGET_MAP: Record<EffortLevel, number> = { low: 1024, medium: 8192, high: 32000, xhigh: 32000, max: 48000 };

// Per-effort output floor for adaptive models: prevents starving thinking at xhigh/max.
// high:16384 = today's agent-loop value (no regression). xhigh/max raise headroom.
const EFFORT_MAX_TOKENS_FLOOR: Record<EffortLevel, number> =
  { low: 4096, medium: 8192, high: 16384, xhigh: 32000, max: 64000 };

// Adaptive models think whether or not Zone configures an effort level — the server
// decides. Thinking is spent inside max_tokens, so the floor must apply on the
// effort-unset path too; "high" is the level whose floor equals the agent loop's
// historical 16384 ceiling, so this can only raise a budget, never lower one.
const DEFAULT_ADAPTIVE_EFFORT: EffortLevel = "high";

export interface ConvertParamsExtras {
  effort?: EffortLevel;
  webSearch?: boolean;
}

const JSON_MODE_INSTRUCTION = [
  "You must respond with a single valid JSON object only.",
  "",
  "CRITICAL RULES:",
  "- DO NOT wrap your response in markdown code fences (no ```json or ```).",
  "- DO NOT include any preamble, explanation, or trailing text.",
  "- Your response MUST start directly with { and end with }.",
  "- The entire response must be parseable by JSON.parse() without preprocessing.",
  "",
  "Example of correct response:",
  '{"key":"value","count":42}',
  "",
  "Example of WRONG response (do NOT do this):",
  "```json",
  '{"key":"value"}',
  "```",
].join("\n");

// Anthropic prompt caching: minimum prompt size for a cache breakpoint to be
// honored — below it the API silently no-ops the cache_control marker. The figure
// is per-model (getCacheMinChars); Sonnet 4.x's ~2048 tokens remains the default.
// Char heuristic throughout: 4 chars ≈ 1 token.
function isCacheEligible(
  systemText: string,
  tools: Anthropic.Tool[] | undefined,
  model: string
): boolean {
  const minChars = getCacheMinChars(model);
  // System alone clears the minimum: eligible even without tools.
  if (systemText.length >= minChars) return true;
  if (!tools || tools.length === 0) return false;
  const toolsChars = tools.reduce((sum, t) => {
    const desc = typeof t.description === "string" ? t.description.length : 0;
    const schema = JSON.stringify(t.input_schema || {}).length;
    return sum + t.name.length + desc + schema;
  }, 0);
  return (systemText.length + toolsChars) >= minChars;
}

const UNSUPPORTED_OPENAI_PARAMS = [
  "frequency_penalty",
  "presence_penalty",
  "logit_bias",
  "n",
  "seed",
  "logprobs",
  "top_logprobs",
] as const;

export interface ConvertParamsResult {
  params: Anthropic.MessageCreateParams;
  warnings: string[];
}

export function convertParams(
  input: ChatCompletionCreateParams,
  extras?: ConvertParamsExtras
): ConvertParamsResult {
  const warnings: string[] = [];

  const { systemPrompt, conversational } = extractSystem(input.messages);

  const messages = translateMessages(conversational, input.model);

  let finalSystem = systemPrompt;
  if (
    input.response_format &&
    typeof input.response_format === "object" &&
    "type" in input.response_format &&
    input.response_format.type === "json_object"
  ) {
    finalSystem = finalSystem
      ? `${JSON_MODE_INSTRUCTION}\n\n${finalSystem}`
      : JSON_MODE_INSTRUCTION;
  }

  const tools = translateTools(input.tools, warnings);
  const tool_choice = translateToolChoice(input.tool_choice);

  // No caller-supplied budget → the model's own output ceiling. A fixed small default
  // (formerly 4096) silently truncated thinking models mid-answer: thinking is billed
  // inside max_tokens, so plan-gen/summarizer JSON came back cut off.
  const max_tokens =
    typeof input.max_tokens === "number" && input.max_tokens > 0
      ? input.max_tokens
      : typeof input.max_completion_tokens === "number" && input.max_completion_tokens > 0
        ? input.max_completion_tokens
        : getMaxOutputTokens(input.model);

  const temperature =
    typeof input.temperature === "number"
      ? clamp(input.temperature, 0, 1)
      : undefined;

  for (const dropped of UNSUPPORTED_OPENAI_PARAMS) {
    if (input[dropped as keyof ChatCompletionCreateParams] !== undefined) {
      warnings.push(`anthropic: dropped unsupported param '${dropped}'`);
    }
  }

  const stop_sequences = normalizeStopSequences(input.stop);

  // Prompt caching: attach cache_control to the stable prefix so Anthropic can
  // reuse it across iterations. Cache hits cost 10% of base input, write 1.25x
  // (5-min TTL). Two strategies depending on whether tools are present:
  //   • tools present: last-tool breakpoint covers system+tools (no separate system breakpoint needed).
  //   • no tools (synthesis calls): system block gets cache_control directly.
  const cacheEligible = isCacheEligible(finalSystem || "", tools, input.model);
  let systemForRequest: Anthropic.MessageCreateParams["system"] = finalSystem || undefined;
  let toolsForRequest: Anthropic.Messages.ToolUnion[] | undefined = tools;

  if (cacheEligible) {
    if (tools && tools.length > 0) {
      // Convert system to array form (defense in depth for a future 2nd breakpoint).
      if (finalSystem) {
        systemForRequest = [
          { type: "text", text: finalSystem },
        ];
      }
      // Attach cache_control to the last tool; covers system + all tools.
      toolsForRequest = tools.map((t, i) =>
        i === tools.length - 1
          ? { ...t, cache_control: { type: "ephemeral" } }
          : t
      );
    } else if (finalSystem) {
      // No tools (synthesis/chat calls): cache the system block directly.
      systemForRequest = [
        { type: "text", text: finalSystem, cache_control: { type: "ephemeral" } },
      ];
    }
  }

  if (extras?.webSearch) {
    const wsEntry: Anthropic.Messages.WebSearchTool20250305 = {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 3,
    };
    toolsForRequest = toolsForRequest ? [...toolsForRequest, wsEntry] : [wsEntry];
  }

  // Tur prompt-caching-2: second breakpoint on the LAST user message (default
  // ON since field validation in May 2026; ~52-83% input savings observed).
  // Extends cached prefix to include conversation history. Each iter moves the
  // breakpoint forward; Anthropic re-uses everything up to (and including) the
  // previous iter's tail. Set ZONE_ENABLE_MESSAGE_CACHE=0 to opt out.
  const messageCacheEnabled =
    String(process.env["ZONE_ENABLE_MESSAGE_CACHE"] || "1")
      .trim()
      .toLowerCase() !== "0";

  const messagesForRequest = applyMessageCacheBreakpoint2(messages, {
    enabled: messageCacheEnabled && cacheEligible,
  });

  // Adaptive-only family (Opus 4.8/4.7): thinking:{type:"adaptive"} + output_config.effort.
  // budget_tokens / temperature / top_p / stop_sequences are all removed on this family (API 400 otherwise).
  // Non-adaptive path (Sonnet/Haiku/OpenAI): unchanged — temperature/top_p/stop_sequences/budget_tokens
  // flow exactly as before.
  const adaptive = usesAdaptiveThinking(input.model);
  const resolvedEffort = resolveEffortForModel(input.model, extras?.effort);

  const thinkingBudget =
    !adaptive && resolvedEffort && supportsEffort(input.model)
      ? EFFORT_BUDGET_MAP[resolvedEffort]
      : undefined;

  // Floor applies whenever the model thinks — including adaptive models with no
  // configured effort, which previously got no floor at all.
  const thinkingFloor = thinkingBudget
    ? thinkingBudget + 2048
    : adaptive
      ? EFFORT_MAX_TOKENS_FLOOR[resolvedEffort ?? DEFAULT_ADAPTIVE_EFFORT]
      : 0;
  // Clamp to the model's declared ceiling: over-asking is a hard 400. Unlisted models
  // pass through unclamped — we don't know their ceiling and must not invent one.
  const modelCeiling = lookupMaxOutputTokens(input.model);
  const budgetedMaxTokens = Math.max(max_tokens, thinkingFloor);
  const effectiveMaxTokens =
    modelCeiling !== undefined ? Math.min(budgetedMaxTokens, modelCeiling) : budgetedMaxTokens;

  const params: Anthropic.MessageCreateParams = {
    model: input.model,
    max_tokens: effectiveMaxTokens,
    messages: messagesForRequest,
    ...(systemForRequest ? { system: systemForRequest } : {}),
    ...(!adaptive && !thinkingBudget && temperature !== undefined ? { temperature } : {}),
    ...(!adaptive && typeof input.top_p === "number" ? { top_p: input.top_p } : {}),
    ...(!adaptive && !thinkingBudget && stop_sequences ? { stop_sequences } : {}),
    ...(toolsForRequest ? { tools: toolsForRequest } : {}),
    ...(tool_choice ? { tool_choice } : {}),
    ...(adaptive && resolvedEffort
      ? {
          thinking: { type: "adaptive" as const },
          output_config: { effort: resolvedEffort },
        }
      : !adaptive && thinkingBudget
        ? { thinking: { type: "enabled" as const, budget_tokens: thinkingBudget } }
        : {}),
  };

  return { params, warnings };
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function extractSystem(
  messages: ChatCompletionMessageParam[]
): { systemPrompt: string; conversational: ChatCompletionMessageParam[] } {
  const systemParts: string[] = [];
  const conversational: ChatCompletionMessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : extractTextFromContentArray(msg.content);
      if (text) systemParts.push(text);
    } else {
      conversational.push(msg);
    }
  }
  return {
    systemPrompt: systemParts.join("\n\n"),
    conversational,
  };
}

function extractTextFromContentArray(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && "type" in block) {
      const b = block as { type: unknown; text?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }
  return parts.join("\n");
}

function translateMessages(
  messages: ChatCompletionMessageParam[],
  requestModel?: string
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  // Decided here, never by rewriting history: the R2 shim reuses its previous
  // pruned array by reference, so stripping thinking from a message would
  // corrupt a prefix another iteration is still holding.
  const replayThinkingAt = selectThinkingReplayIndices(messages, requestModel);

  for (let msgIdx = 0; msgIdx < messages.length; msgIdx += 1) {
    const msg = messages[msgIdx]!;
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        out.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const blocks: Anthropic.ContentBlockParam[] = [];
        for (const block of msg.content) {
          if (!block || typeof block !== "object" || !("type" in block)) continue;
          const b = block as { type: unknown; text?: unknown; image_url?: { url?: string } };
          if (b.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", text: b.text });
          } else if (b.type === "image_url" && typeof b.image_url?.url === "string") {
            const match = b.image_url.url.match(/^data:([^;]+);base64,(.+)$/s);
            if (match) {
              blocks.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: match[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                  data: match[2],
                },
              });
            }
          }
        }
        out.push({ role: "user", content: blocks.length > 0 ? blocks : extractTextFromContentArray(msg.content) });
      } else {
        out.push({ role: "user", content: "" });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: Array<
        | Anthropic.TextBlockParam
        | Anthropic.ToolUseBlockParam
        | Anthropic.ThinkingBlockParam
        | Anthropic.RedactedThinkingBlockParam
      > = [];

      // Thinking goes first, ahead of text and tool_use, and by reference — the
      // signature is validated over the block's exact bytes, so re-serializing
      // it (even into an identical-looking object) is the one transform it
      // cannot survive.
      //
      // @unverified-probe(thinking:token-saving) The benefit is a hypothesis
      // with n=1 behind it: one observed turn spent 906 thinking tokens
      // re-deriving 579 tokens of reasoning it could not see. Whether replaying
      // the block actually lowers turn-2 thinking, and by how much against the
      // run-to-run spread, is what scripts/thinking-probe.mjs measures. The
      // mechanism is correct either way; the payoff is not yet a number.
      if (replayThinkingAt.has(msgIdx)) {
        const state = readProviderState(msg);
        if (state) {
          blocks.push(
            ...(state.blocks as unknown as Array<
              Anthropic.ThinkingBlockParam | Anthropic.RedactedThinkingBlockParam
            >)
          );
        }
      }

      const textContent =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? extractTextFromContentArray(msg.content)
            : "";

      const toolCalls = msg.tool_calls;

      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        if (textContent) {
          blocks.push({ type: "text", text: textContent });
        }
        for (const tc of toolCalls) {
          if (tc.type !== "function") continue;
          let parsedInput: unknown = {};
          try {
            parsedInput = tc.function.arguments
              ? JSON.parse(tc.function.arguments)
              : {};
          } catch {
            parsedInput = {};
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
        out.push({ role: "assistant", content: blocks });
      } else if (blocks.length > 0) {
        // Only reachable if the replay selection is ever widened past turns with
        // tool_calls. Emitting the array form rather than the string keeps that
        // change from silently discarding thinking.
        if (textContent) blocks.push({ type: "text", text: textContent });
        out.push({ role: "assistant", content: blocks });
      } else {
        out.push({ role: "assistant", content: textContent });
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolResultText =
        typeof msg.content === "string"
          ? msg.content
          : extractTextFromContentArray(msg.content);
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: toolResultText,
      };

      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every(
          (b) =>
            (b as { type?: unknown }).type === "tool_result"
        )
      ) {
        (last.content as Anthropic.ToolResultBlockParam[]).push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    // Other roles ignored (function-style legacy messages, developer, etc.)
  }

  return out;
}

function translateTools(
  tools: ChatCompletionTool[] | undefined,
  warnings: string[]
): Anthropic.Tool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Anthropic.Tool[] = [];
  for (const tool of tools) {
    if (tool.type !== "function") {
      warnings.push(
        `anthropic: dropped non-function tool of type='${
          (tool as { type?: string }).type ?? "unknown"
        }'`
      );
      continue;
    }
    const fn = tool.function;
    if (!fn || typeof fn.name !== "string" || !fn.name) {
      warnings.push("anthropic: dropped tool with missing name");
      continue;
    }
    const inputSchema =
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as Anthropic.Tool.InputSchema)
        : ({ type: "object" as const, properties: {} } as Anthropic.Tool.InputSchema);
    out.push({
      name: fn.name,
      ...(typeof fn.description === "string" && fn.description
        ? { description: fn.description }
        : {}),
      input_schema: inputSchema,
    });
  }
  return out.length > 0 ? out : undefined;
}

function translateToolChoice(
  toolChoice: ChatCompletionToolChoiceOption | undefined
): Anthropic.ToolChoice | undefined {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "required") return { type: "any" };
  if (typeof toolChoice === "object" && toolChoice && "type" in toolChoice) {
    if (toolChoice.type === "function" && toolChoice.function?.name) {
      return { type: "tool", name: toolChoice.function.name };
    }
  }
  return undefined;
}

function normalizeStopSequences(
  stop: string | string[] | null | undefined
): string[] | undefined {
  if (stop === undefined || stop === null) return undefined;
  if (typeof stop === "string") return stop ? [stop] : undefined;
  if (Array.isArray(stop)) {
    const filtered = stop.filter(
      (s): s is string => typeof s === "string" && s.length > 0
    );
    return filtered.length > 0 ? filtered : undefined;
  }
  return undefined;
}
