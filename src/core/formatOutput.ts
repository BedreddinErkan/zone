import type { RunAgentResult } from "./runAgent.js";
import { renderRunAgentResult } from "./renderRunAgentResult.js";

export type OutputFormat = "text" | "json";

export function formatOutput(result: RunAgentResult, format: OutputFormat): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  return renderRunAgentResult(result);
}
