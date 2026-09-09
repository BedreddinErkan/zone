import React from "react";
import { useStore } from "../store.js";
import type { OverlayId } from "../store-core.js";
import { role } from "../theme.js";
import { OverlayShell } from "./primitives/index.js";
import { ModelPicker } from "./ModelPicker.js";
import { ApiKeysManager } from "./ApiKeysManager.js";
import { MetricsDashboard } from "./MetricsDashboard.js";

/**
 * Phase 2c — central overlay renderer. Reads the top of `overlayStack` and dispatches
 * to the right content component wrapped in OverlayShell. App.tsx renders this exactly
 * once, in the live-output slot, when `selectIsBlockingModalOpen` is true.
 *
 * Returns null when the stack is empty — the component is rendered unconditionally by
 * App.tsx but only paints when there is actually an overlay to paint, so a pop/clear
 * from another source (RUN_DONE's OVERLAY_CLEAR, a test's direct dispatch) does not
 * leave a dangling DOM subtree.
 *
 * Each content component handles its own useInput; the central Esc handler (Phase 3b)
 * will live one level up and dispatch OVERLAY_POP without knowing what it is closing.
 * Until then, each component closes itself via OVERLAY_POP on Esc.
 */

const OVERLAY_TITLES: Record<OverlayId, string> = {
  model: "Model",
  keys: "API Keys",
  metrics: "Metrics",
  effort: "Effort",
  summary: "Summary Format",
  planMode: "Plan Mode",
  session: "Session Memory",
  sessions: "Sessions",
  permissions: "Permissions",
  limits: "Spending Limits",
  commit: "Commit",
  feedback: "Feedback",
  undo: "Undo Changes",
};

export function OverlayLayer(): React.ReactElement | null {
  const { state } = useStore();
  const topOverlay = state.overlayStack[state.overlayStack.length - 1];
  if (!topOverlay) return null;

  let children: React.ReactElement;
  let keyHints: { key: string; label: string; primary?: boolean }[] = [];
  let widthPolicy: "narrow" | "wide" | "full" = "wide";

  switch (topOverlay) {
    case "model":
      children = <ModelPicker />;
      keyHints = [
        { key: "↑↓", label: "navigate" }, // glyph: keyboard-shortcut — physical key labels for useInput, not the seam's navigateArrows
        { key: "Enter", label: "select", primary: true },
        { key: "C", label: "custom" },
        { key: "Esc", label: "close" },
      ];
      break;
    case "keys":
      children = <ApiKeysManager />;
      keyHints = [
        { key: "N", label: "new" },
        { key: "E", label: "edit" },
        { key: "P", label: "price" },
        { key: "Del", label: "remove" },
        { key: "Esc", label: "close" },
      ];
      break;
    case "metrics":
      children = <MetricsDashboard />;
      keyHints = [
        { key: "←→", label: "period" }, // glyph: keyboard-shortcut — physical key labels for useInput
        { key: "R", label: "auto-refresh" },
        { key: "Esc", label: "close" },
      ];
      widthPolicy = "wide";
      break;
    // Phase 2d will fill the remaining 10 cases. Until then, an id that landed here without
    // a content component is a bug — returning null rather than throwing so the rest of the
    // UI stays usable.
    default:
      return null;
  }

  return (
    <OverlayShell
      title={OVERLAY_TITLES[topOverlay]}
      borderStyle="round"
      borderColor={role.accent}
      width={widthPolicy}
      keyHints={keyHints}
    >
      {children}
    </OverlayShell>
  );
}
