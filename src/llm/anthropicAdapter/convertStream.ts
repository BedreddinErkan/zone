import type Anthropic from "@anthropic-ai/sdk";
import type { ChatCompletionChunk } from "openai/resources/chat/completions";
import { convertStopReason } from "./convertResponse.js";

interface BlockState {
  kind: "text" | "tool_use" | "ignored";
  toolIndex?: number;
}

export async function* convertStream(
  source: AsyncIterable<Anthropic.MessageStreamEvent>
): AsyncGenerator<ChatCompletionChunk, void, unknown> {
  const created = Math.floor(Date.now() / 1000);
  let id = "";
  let model = "";
  let stopReason: Anthropic.StopReason | null = null;
  let nextToolIndex = 0;
  const blocks = new Map<number, BlockState>();
  let initialChunkEmitted = false;

  for await (const event of source) {
    switch (event.type) {
      case "message_start": {
        id = event.message.id || id;
        model = event.message.model || model;
        if (!initialChunkEmitted) {
          initialChunkEmitted = true;
          yield {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "" },
                finish_reason: null,
              },
            ],
          };
        }
        break;
      }

      case "content_block_start": {
        const blk = event.content_block;
        if (blk.type === "text") {
          blocks.set(event.index, { kind: "text" });
        } else if (blk.type === "tool_use") {
          const toolIndex = nextToolIndex++;
          blocks.set(event.index, { kind: "tool_use", toolIndex });
          yield {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: toolIndex,
                      id: blk.id,
                      type: "function",
                      function: {
                        name: blk.name,
                        arguments: "",
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          };
        } else {
          blocks.set(event.index, { kind: "ignored" });
        }
        break;
      }

      case "content_block_delta": {
        const state = blocks.get(event.index);
        if (!state || state.kind === "ignored") break;
        const delta = event.delta;
        if (state.kind === "text" && delta.type === "text_delta") {
          if (typeof delta.text === "string" && delta.text.length > 0) {
            yield {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: delta.text },
                  finish_reason: null,
                },
              ],
            };
          }
        } else if (
          state.kind === "tool_use" &&
          delta.type === "input_json_delta"
        ) {
          if (
            typeof delta.partial_json === "string" &&
            delta.partial_json.length > 0
          ) {
            yield {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: state.toolIndex ?? 0,
                        function: { arguments: delta.partial_json },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
          }
        }
        break;
      }

      case "content_block_stop": {
        // No emission needed; OpenAI signals completion via final finish_reason chunk.
        break;
      }

      case "message_delta": {
        if (event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason as Anthropic.StopReason;
        }
        break;
      }

      case "message_stop": {
        yield {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: convertStopReason(stopReason),
            },
          ],
        };
        break;
      }

      default:
        // Includes 'ping' and any future event types — ignore.
        break;
    }
  }
}
