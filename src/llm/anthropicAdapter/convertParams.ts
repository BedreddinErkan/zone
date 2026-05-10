import type Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";

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

// Anthropic prompt caching: minimum tokens for a cache breakpoint to be honored.
// Sonnet 4.x requires ~2048 tokens. Below this, the API silently no-ops the
// cache_control marker. Use a conservative char heuristic (4 chars ≈ 1 token).
const CACHE_MIN_CHARS = 8200;

function isCacheEligible(systemText: string, tools: Anthropic.Tool[] | undefined): boolean {
  if (!tools || tools.length === 0) return false;
  const toolsChars = tools.reduce((sum, t) => {
    const desc = typeof t.description === "string" ? t.description.length : 0;
    const schema = JSON.stringify(t.input_schema || {}).length;
    return sum + t.name.length + desc + schema;
  }, 0);
  return (systemText.length + toolsChars) >= CACHE_MIN_CHARS;
}

const DEFAULT_MAX_TOKENS = 4096;

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
  input: ChatCompletionCreateParams
): ConvertParamsResult {
  const warnings: string[] = [];

  const { systemPrompt, conversational } = extractSystem(input.messages);

  const messages = translateMessages(conversational);

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

  const max_tokens =
    typeof input.max_tokens === "number" && input.max_tokens > 0
      ? input.max_tokens
      : DEFAULT_MAX_TOKENS;

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

  // Prompt caching: when the system+tools prefix is large enough to clear the
  // 2048-token minimum, attach cache_control to the last tool. Anthropic's
  // prefix-ladder caches everything before AND including that block — so this
  // single marker covers the entire tools array AND the system prompt with one
  // breakpoint. Cache hits cost 10% of base input, write cost 1.25x (5min TTL).
  const cacheEligible = isCacheEligible(finalSystem || "", tools);
  let systemForRequest: Anthropic.MessageCreateParams["system"] = finalSystem || undefined;
  let toolsForRequest = tools;

  if (cacheEligible && tools && tools.length > 0) {
    // Convert system from string to array form so we can attach cache_control
    // (defense in depth — even though only the tools breakpoint is currently
    // active, structuring system as an array keeps a future second breakpoint
    // a one-line change).
    if (finalSystem) {
      systemForRequest = [
        { type: "text", text: finalSystem },
      ];
    }
    // Attach cache_control to the last tool. SDK type allows it on Tool blocks.
    toolsForRequest = tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: { type: "ephemeral" } }
        : t
    );
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

  let messagesForRequest: Anthropic.MessageParam[] = messages;

  if (messageCacheEnabled && cacheEligible && messages.length > 0) {
    // Find the index of the LAST user message (a tool_result-bearing user
    // message also counts — what matters is "user" role).
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }

    if (lastUserIdx >= 0) {
      // Skip the trivial single-tiny-user-message case (no reuse expected).
      const isFirstAndTiny =
        lastUserIdx === 0 &&
        messages.length === 1 &&
        typeof messages[0].content === "string" &&
        messages[0].content.length < 500;

      if (!isFirstAndTiny) {
        messagesForRequest = messages.map((msg, i) => {
          if (i !== lastUserIdx) return msg;

          // user.content can be string or content-block array.
          // To attach cache_control we need an array with at least one block,
          // and we attach to the LAST block of that array.
          if (typeof msg.content === "string") {
            return {
              ...msg,
              content: [
                {
                  type: "text" as const,
                  text: msg.content,
                  cache_control: { type: "ephemeral" as const },
                },
              ],
            };
          }
          if (Array.isArray(msg.content) && msg.content.length > 0) {
            const lastBlockIdx = msg.content.length - 1;
            return {
              ...msg,
              content: msg.content.map((block, bi) =>
                bi === lastBlockIdx
                  ? ({ ...block, cache_control: { type: "ephemeral" } } as typeof block)
                  : block
              ),
            };
          }
          return msg;
        });
      }
    }
  }

  const params: Anthropic.MessageCreateParams = {
    model: input.model,
    max_tokens,
    messages: messagesForRequest,
    ...(systemForRequest ? { system: systemForRequest } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(typeof input.top_p === "number" ? { top_p: input.top_p } : {}),
    ...(stop_sequences ? { stop_sequences } : {}),
    ...(toolsForRequest ? { tools: toolsForRequest } : {}),
    ...(tool_choice ? { tool_choice } : {}),
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
  messages: ChatCompletionMessageParam[]
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
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
        Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam
      > = [];

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
