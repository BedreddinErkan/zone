import { createContext, useContext, useReducer, type Dispatch } from "react";
import { buildInitialState, reducer } from "./store-core.js";
import type { StoreState, StoreAction, TranscriptEntry, TuiMode } from "./store-core.js";
import type { DiskModelSettings } from "../../api/diskModel.js";
import type { UserCommand } from "./userCommands.js";
import type { UserHooksConfig } from "../../api/diskHooks.js";

export * from "./store-core.js";

const StoreContext = createContext<{ state: StoreState; dispatch: Dispatch<StoreAction> } | null>(null);

export function useStore(): { state: StoreState; dispatch: Dispatch<StoreAction> } {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}

export function StoreProvider({
  children,
  initialValues,
}: {
  children: React.ReactNode;
  initialValues?: {
    model: string;
    capUsd: number;
    dailyUsedUsd?: number;
    trustedPrefixes?: string[];
    resumedTranscript?: TranscriptEntry[];
    resumedSessionId?: string;
    resumedStartedAt?: string;
    modelSettings?: DiskModelSettings | null;
    userCommands?: UserCommand[];
    mode?: TuiMode;
    armedUserHooks?: UserHooksConfig | null;
    pendingHookTrust?: { config: UserHooksConfig; hash: string; projectPath: string } | null;
    armedMcpManager?: import("../../mcp/mcpClientManager.js").McpClientManager | null;
    pendingMcpTrust?: { config: import("../../api/diskMcp.js").McpConfig; hash: string; projectPath: string } | null;
  };
}): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, () =>
    buildInitialState(initialValues)
  );
  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      {children}
    </StoreContext.Provider>
  );
}
