import type { Dispatch } from "react";
import type { StoreAction } from "./store.js";
import { runInitFlow, stripTrailingCodeBlock } from "../../memory/initFlow.js";

export { stripTrailingCodeBlock };

export async function runInit(
  cwd: string,
  dispatch: Dispatch<StoreAction>,
  ac: AbortController,
): Promise<void> {
  dispatch({ type: "SPINNER_START", label: "Analyzing repo…" });
  try {
    const result = await runInitFlow(
      cwd,
      (msg) => dispatch({ type: "SPINNER_UPDATE", label: msg }),
      ac.signal,
    );
    dispatch({ type: "STATUS_UPDATE", costUsd: result.costUsd ?? 0 });
    dispatch({ type: "RUN_DONE" });
    dispatch({ type: "USER_PROMPT", text: result.message });
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      dispatch({ type: "RUN_DONE" });
      dispatch({ type: "USER_PROMPT", text: `init: ${(err as Error).message}` });
    }
    // AbortError: Esc handler already dispatched RUN_ABORTED,
    // or /exit already called exit() — either way, no further dispatch needed.
  }
}
