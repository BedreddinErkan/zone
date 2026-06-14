import type { Mock } from "vitest";

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
const U = (i = 10, o = 5): Usage => ({ prompt_tokens: i, completion_tokens: o, total_tokens: i + o });

export function scriptText(content: string, usage = U()) {
  return { choices: [{ message: { content, tool_calls: null }, finish_reason: "stop" }], usage };
}

export function scriptToolCall(
  name: string,
  args: object,
  opts: { id?: string; usage?: Usage } = {}
) {
  return {
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: opts.id ?? `call_${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: opts.usage ?? U(),
  };
}

export const scriptDone = (text = "Done.", usage = U()) => scriptText(text, usage);

export function scriptTruncated(content: string, usage = U()) {
  return { choices: [{ message: { content, tool_calls: null }, finish_reason: "length" }], usage };
}

export function scriptRefusal(
  refusal = "Request declined by safety classifier.",
  usage = U()
) {
  return {
    choices: [{
      message: { content: null, tool_calls: null, refusal },
      finish_reason: "content_filter",
    }],
    usage,
  };
}

/**
 * Install a scripted sequence onto a pre-hoisted createChatCompletion mock.
 * Each item in `outputs` is returned once (in order); after the queue is
 * exhausted, `opts.final` is returned for every subsequent call (default: scriptDone()).
 *
 * Receives the mock as a parameter to avoid importing `vi` at module level
 * (ESM temporal dead zone — same pattern as resetToolExecutorMock).
 */
export function installScript(
  mock: Mock,
  outputs: object[],
  opts: { final?: object } = {}
) {
  mock.mockReset();
  for (const o of outputs) mock.mockResolvedValueOnce(o);
  mock.mockResolvedValue(opts.final ?? scriptDone());
}
