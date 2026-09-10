import React from "react";
import { useStore } from "../store.js";
import type { OverlayId } from "../store-core.js";
import { role } from "../theme.js";
import { OverlayShell } from "./primitives/index.js";
import { ModelPicker } from "./ModelPicker.js";
import { ApiKeysManager } from "./ApiKeysManager.js";
import { MetricsDashboard } from "./MetricsDashboard.js";
import { EffortPicker } from "./EffortPicker.js";
import { SummaryPicker } from "./SummaryPicker.js";
import { PlanModePicker } from "./PlanModePicker.js";
import { SessionMemoryPicker } from "./SessionMemoryPicker.js";
import { SessionBrowser } from "./SessionBrowser.js";
import { PermissionsManager } from "./PermissionsManager.js";
import { LimitsEditor } from "./LimitsEditor.js";
import { CommitEditor } from "./CommitEditor.js";
import { FeedbackForm } from "./FeedbackForm.js";
import { UndoConfirm } from "./UndoConfirm.js";
import { TrustPrompt } from "./TrustPrompt.js";
import { HookTrustPrompt } from "./HookTrustPrompt.js";
import { McpTrustPrompt } from "./McpTrustPrompt.js";

/**
 * Phase 2c+2d — central overlay renderer. Reads the top of `overlayStack` and dispatches
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
  trust: "Trust this folder?",
  hookTrust: "Hook Trust Required",
  mcpTrust: "MCP Servers — Trust Required",
};

/** Trust-decision overlays use caution (yellow) chrome; settings overlays use accent (default). */
const CAUTION_OVERLAYS: ReadonlySet<OverlayId> = new Set(["trust", "hookTrust", "mcpTrust", "undo"]);

export function OverlayLayer(): React.ReactElement | null {
  const { state } = useStore();
  const topOverlay = state.overlayStack[state.overlayStack.length - 1];
  if (!topOverlay) return null;

  let children: React.ReactElement | null = null;
  let keyHints: { key: string; label: string; primary?: boolean }[] = [];
  let widthPolicy: "narrow" | "wide" | "full" = "wide";

  switch (topOverlay) {
    case "model":
      children = <ModelPicker />;
      keyHints = [
        { key: "↑↓", label: "navigate" }, // glyph: keyboard-shortcut — physical key labels for useInput
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
        { key: "←→", label: "period" },
        { key: "R", label: "auto-refresh" },
        { key: "Esc", label: "close" },
      ];
      break;
    case "effort":
      children = <EffortPicker />;
      widthPolicy = "narrow";
      keyHints = [
        { key: "↑↓", label: "navigate" }, // glyph: keyboard-shortcut
        { key: "Enter", label: "select", primary: true },
        { key: "Esc", label: "close" },
      ];
      break;
    case "summary":
      children = <SummaryPicker />;
      widthPolicy = "narrow";
      keyHints = [
        { key: "↑↓", label: "navigate" }, // glyph: keyboard-shortcut
        { key: "Enter", label: "select", primary: true },
        { key: "Esc", label: "close" },
      ];
      break;
    case "planMode":
      children = <PlanModePicker />;
      widthPolicy = "narrow";
      keyHints = [
        { key: "↑↓", label: "navigate" }, // glyph: keyboard-shortcut
        { key: "Enter", label: "select", primary: true },
        { key: "Esc", label: "close" },
      ];
      break;
    case "session":
      children = <SessionMemoryPicker />;
      widthPolicy = "narrow";
      keyHints = [
        { key: "↑↓", label: "navigate" }, // glyph: keyboard-shortcut
        { key: "Enter", label: "select", primary: true },
        { key: "Esc", label: "close" },
      ];
      break;
    case "sessions":
      children = <SessionBrowser />;
      keyHints = [
        { key: "↑↓", label: "navigate" }, // glyph: keyboard-shortcut
        { key: "Enter", label: "resume", primary: true },
        { key: "Esc", label: "close" },
      ];
      break;
    case "permissions":
      children = <PermissionsManager />;
      keyHints = [
        { key: "↑↓", label: "navigate" }, // glyph: keyboard-shortcut
        { key: "Del", label: "remove" },
        { key: "Esc", label: "close" },
      ];
      break;
    case "limits":
      children = <LimitsEditor />;
      widthPolicy = "narrow";
      keyHints = [
        { key: "Enter", label: "apply", primary: true },
        { key: "Esc", label: "cancel" },
      ];
      break;
    case "commit":
      children = <CommitEditor />;
      keyHints = [
        { key: "Enter", label: "commit", primary: true },
        { key: "Esc", label: "cancel" },
      ];
      break;
    case "feedback":
      children = <FeedbackForm />;
      keyHints = [
        { key: "Enter", label: "send", primary: true },
        { key: "Esc", label: "cancel" },
      ];
      break;
    case "undo":
      children = <UndoConfirm />;
      keyHints = [
        { key: "Y/Enter", label: "confirm", primary: true },
        { key: "N/Esc", label: "cancel" },
      ];
      break;
    case "trust":
      children = <TrustPrompt />;
      keyHints = [
        { key: "y", label: "trust", primary: true },
        { key: "N", label: "don't trust" },
      ];
      break;
    case "hookTrust":
      children = <HookTrustPrompt />;
      keyHints = [
        { key: "y", label: "approve", primary: true },
        { key: "N", label: "disable" },
      ];
      break;
    case "mcpTrust":
      children = <McpTrustPrompt />;
      keyHints = [
        { key: "y", label: "approve", primary: true },
        { key: "N", label: "disable" },
      ];
      break;
    default:
      return null;
  }

  if (!children) return null;

  const borderColor = CAUTION_OVERLAYS.has(topOverlay) ? role.caution : role.accent;

  return (
    <OverlayShell
      title={OVERLAY_TITLES[topOverlay]}
      borderStyle="round"
      borderColor={borderColor}
      width={widthPolicy}
      keyHints={keyHints}
    >
      {children}
    </OverlayShell>
  );
}
