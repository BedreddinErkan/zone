import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseIncludable,
  FunctionTool,
} from "openai/resources/responses/responses.js";
import { resolveEffortForModel, supportsEffort } from "../modelRegistry.js";
import type { EffortLevel } from "../modelRegistry.js";
import type { ModelCapabilities } from "../types.js";

export function responsesConvertParams(
  params: ChatCompletionCreateParamsNonStreaming,
  options: { effort?: EffortLevel; capabilities?: ModelCapabilities }
): ResponseCreateParamsNonStreaming {
  // Extract the first system message as top-level instructions.
  // Subsequent system messages (e.g., compaction's [compacted_history]) become developer input items
  // so they retain their position in the conversation and don't bloat the static instructions field.
  let instructions: string | undefined;
  const input: ResponseInputItem[] = [];

  for (const msg of params.messages) {
    translateMessage(msg, input, (sys) => {
      if (instructions === undefined) {
        instructions = sys;
      } else {
        // Additional system message (post-compaction) → developer role input item
        input.push({
          type: "message",
          role: "developer",
          content: sys,
        } as ResponseInputItem);
      }
    });
  }

  // Tools: unnest {type:"function", function:{name,description,parameters}} → flat FunctionTool
  const tools: FunctionTool[] | undefined =
    params.tools && params.tools.length > 0
      ? params.tools
          .filter((t): t is Extract<typeof t, { type: "function" }> => t.type === "function")
          .map((t) => ({
            type: "function" as const,
            name: t.function.name,
            description: t.function.description ?? undefined,
            parameters: (t.function.parameters ?? null) as { [key: string]: unknown } | null,
            strict: null,
          }))
      : undefined;

  // Effort → reasoning.effort, same xhigh/max→"high" narrowing as openaiAdapter.ts:63-65.
  //
  // `reasoning` is gated on supportsEffort(model), NOT on whether an effort override resolved —
  // those are different questions, and gating on the override would send the parameter to
  // whatever the user happened to pass a flag for rather than to whatever can actually use it.
  //
  // An earlier version of this comment justified the gate with gpt-5.4-nano, calling it a
  // "reasoning model in name, not in this catalog's capability model." That was a stipulation
  // read off the catalog's own membership, never a measurement, and it was wrong: nano accepts
  // reasoning.effort AND reasoning.summary at low/medium/high and returns real summary prose at
  // every one (measured 2026-08-20). It is in EFFORT_SUPPORTED_MODELS now. The gate is still the
  // right condition, but for a narrower reason than was claimed — what it excludes today is an
  // UNLISTED gpt-5* id, which reaches this converter because the routing gate is a bare
  // startsWith("gpt-5") on a string the OPENAI_MODEL / ZONE_LLM_MODEL_HIGH env vars set with no
  // catalog validation, and which has no capability entry to authorise reasoning against.
  //
  // summary:"auto" is fixed, not configurable — no CLI flag/env/disk setting. The text this
  // requests is only ever displayed behind the existing investigation-mode + tool-call + runId
  // gate in agentLoop.ts, which has no user-facing toggle on the Anthropic side either; adding
  // one only for OpenAI's request shape would be an asymmetry nothing asks for.
  //
  // The explicit `ResponseCreateParamsNonStreaming["reasoning"]` annotation on `reasoning` is
  // load-bearing, not decorative: without it, `summary: "auto"` widens to plain `string` on
  // this standalone const and fails structural assignability against the SDK's own
  // `'auto' | 'concise' | 'detailed' | null` field the first time it's assigned into `result`.
  const resolvedEffort = resolveEffortForModel(params.model, options.effort, options.capabilities);
  const narrowedEffort =
    resolvedEffort === "xhigh" || resolvedEffort === "max" ? "high" : resolvedEffort;
  const reasoning: ResponseCreateParamsNonStreaming["reasoning"] = supportsEffort(params.model, options.capabilities)
    ? { summary: "auto", ...(narrowedEffort ? { effort: narrowedEffort } : {}) }
    : undefined;

  const result: ResponseCreateParamsNonStreaming = {
    model: params.model,
    input,
    ...(instructions !== undefined ? { instructions } : {}),
    ...(tools ? { tools } : {}),
    ...(params.tool_choice ? { tool_choice: params.tool_choice as "auto" | "none" | "required" } : {}),
    max_output_tokens: params.max_tokens ?? (params as { max_completion_tokens?: number }).max_completion_tokens ?? undefined,
    ...(reasoning ? { reasoning } : {}),
    store: false,
    include: ["reasoning.encrypted_content" as ResponseIncludable],
    ...((params as { prompt_cache_key?: string }).prompt_cache_key
      ? { prompt_cache_key: (params as { prompt_cache_key?: string }).prompt_cache_key }
      : {}),
    stream: false,
  };

  return result;
}

function translateMessage(
  msg: ChatCompletionMessageParam,
  input: ResponseInputItem[],
  onSystem: (content: string) => void
): void {
  if (msg.role === "system") {
    const text = typeof msg.content === "string" ? msg.content : "";
    onSystem(text);
    return;
  }

  if (msg.role === "user") {
    if (typeof msg.content === "string") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: msg.content }],
      } as ResponseInputItem);
    } else if (Array.isArray(msg.content)) {
      const contentParts = msg.content.map((part) => {
        if (part.type === "text") {
          return { type: "input_text" as const, text: part.text };
        }
        if (part.type === "image_url") {
          return { type: "input_image" as const, image_url: part.image_url.url, detail: "auto" as const };
        }
        // Unsupported part type — skip (future-proof)
        return null;
      }).filter((p): p is NonNullable<typeof p> => p !== null);
      input.push({
        type: "message",
        role: "user",
        content: contentParts,
      } as unknown as ResponseInputItem);
    }
    return;
  }

  if (msg.role === "assistant") {
    const toolCalls = (msg as { tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[] }).tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      // Plain assistant text turn
      const text = typeof msg.content === "string" ? msg.content : "";
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      } as ResponseInputItem);
      return;
    }

    // Assistant turn with tool calls: reasoning → content (if any) → function_call items
    // S4-SEAM: carrier.lookup(callIds) — insert reasoning items here, before content or function_call items.
    // S4 will add:
    //   const callIds = toolCalls.map(tc => tc.id);
    //   const reasoningItems = carrier?.lookup(callIds);
    //   input.push(...reasoningItems);

    const content = typeof msg.content === "string" ? msg.content : null;
    if (content) {
      input.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: content }],
      } as ResponseInputItem);
    }

    for (const tc of toolCalls) {
      if (tc.type === "function") {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        } as ResponseInputItem);
      }
    }
    return;
  }

  if (msg.role === "tool") {
    input.push({
      type: "function_call_output",
      call_id: msg.tool_call_id,
      output: typeof msg.content === "string" ? msg.content : "",
    } as ResponseInputItem);
    return;
  }

  // function / developer roles: no-op (not used in Zone's agent loop)
}
