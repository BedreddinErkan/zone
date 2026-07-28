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
  // Derived rather than restated: this was a hand-copied duplicate of
  // buildInitialState's parameter, so every new seed field had to be added twice
  // and silently failed to compile at the second site.
  initialValues?: Parameters<typeof buildInitialState>[0];
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
