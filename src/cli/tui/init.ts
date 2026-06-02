import type { Dispatch } from "react";
import type { StoreAction } from "./store.js";
import { runInitFlow, stripTrailingCodeBlock } from "../../memory/initFlow.js";

export { stripTrailingCodeBlock };

export async function runInit(cwd: string, dispatch: Dispatch<StoreAction>): Promise<void> {
  const result = await runInitFlow(cwd, (msg) => {
    dispatch({ type: "USER_PROMPT", text: msg });
  });
  if (!result.ok) {
    dispatch({ type: "USER_PROMPT", text: result.message });
  }
}
