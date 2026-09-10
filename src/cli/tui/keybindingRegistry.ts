/**
 * Phase 3c — keybinding registry. Pure data, no React/Ink imports, so it can later
 * drive /help generation and conflict detection without pulling in the render tree.
 *
 * Every useInput handler in the TUI should have a corresponding entry here. The
 * keybindingRegistry.test.ts drift guard scans source files and fails if a handler
 * appears in code but not in this inventory.
 *
 * Keys are normalized lowercase tokens: "escape", "enter", "tab", "shift+tab",
 * "ctrl+c", "up", "down", "left", "right", "home", "end", "backspace", "delete",
 * single characters ("y", "n", "c", etc.), digit strings ("1"–"9").
 */

export interface KeyBinding {
  /** Logical scope. "global" for App-level, "composer" for Composer, "overlay:<id>" for
   *  OverlayLayer content components, "modal:<name>" for non-overlay modals. */
  context: string;
  /** Normalized key tokens handled by this binding. */
  keys: string[];
  /** Component file basename (without extension). */
  owner: string;
  /** One-line description of what the binding does. */
  action: string;
  /** Context name this binding's isActive is mutually exclusive with. When set,
   *  the test asserts that the two contexts cannot be active simultaneously. */
  exclusiveWith?: string;
}

export const KEYBINDINGS: KeyBinding[] = [
  // ── Global (App.tsx) ──────────────────────────────────────────────────────
  { context: "global", keys: ["ctrl+c"],         owner: "App", action: "exit zone" },
  { context: "global", keys: ["shift+tab"],       owner: "App", action: "cycle mode (normal → auto-accept → plan)" },
  { context: "global", keys: ["escape"],          owner: "App", action: "pop overlay / dismiss question / abort run (selectEscTarget precedence)" },

  // ── Composer ──────────────────────────────────────────────────────────────
  { context: "composer", keys: ["enter"],          owner: "Composer", action: "submit buffer or execute slash command" },
  { context: "composer", keys: ["escape"],         owner: "Composer", action: "clear input / abort run / close palette", exclusiveWith: "global" },
  { context: "composer", keys: ["up"],             owner: "Composer", action: "navigate history (when input empty) or palette" },
  { context: "composer", keys: ["down"],           owner: "Composer", action: "navigate history (when input empty) or palette" },
  { context: "composer", keys: ["tab"],            owner: "Composer", action: "accept @-file completion" },
  { context: "composer", keys: ["backslash"],      owner: "Composer", action: "insert newline (\\+Enter multiline)" },
  { context: "composer", keys: ["left", "right"],  owner: "Composer", action: "cursor movement" },
  { context: "composer", keys: ["home", "end"],    owner: "Composer", action: "cursor to start/end of line" },
  { context: "composer", keys: ["backspace"],      owner: "Composer", action: "delete character in buffer" },

  // ── Overlay: model ────────────────────────────────────────────────────────
  { context: "overlay:model", keys: ["up", "down"],  owner: "ModelPicker", action: "navigate model list" },
  { context: "overlay:model", keys: ["enter"],        owner: "ModelPicker", action: "select model" },
  { context: "overlay:model", keys: ["c"],            owner: "ModelPicker", action: "enter custom model id" },
  { context: "overlay:model-submode", keys: ["escape"],    owner: "ModelPicker", action: "cancel custom input / gateway picker" },
  { context: "overlay:model-submode", keys: ["enter"],     owner: "ModelPicker", action: "confirm custom model / gateway choice" },
  { context: "overlay:model-submode", keys: ["backspace"], owner: "ModelPicker", action: "delete character in custom input" },
  { context: "overlay:model-submode", keys: ["up", "down"], owner: "ModelPicker", action: "navigate gateway list" },

  // ── Overlay: keys ─────────────────────────────────────────────────────────
  { context: "overlay:keys", keys: ["up", "down"],   owner: "ApiKeysManager", action: "navigate key list" },
  { context: "overlay:keys", keys: ["n"],             owner: "ApiKeysManager", action: "new key" },
  { context: "overlay:keys", keys: ["e"],             owner: "ApiKeysManager", action: "edit selected key" },
  { context: "overlay:keys", keys: ["p"],             owner: "ApiKeysManager", action: "price selected key" },
  { context: "overlay:keys", keys: ["delete", "d"],    owner: "ApiKeysManager", action: "remove selected key" },
  { context: "overlay:keys-submode", keys: ["escape"],    owner: "ApiKeysManager", action: "cancel input / pricing / confirm-delete" },
  { context: "overlay:keys-submode", keys: ["enter"],     owner: "ApiKeysManager", action: "submit input / pricing step" },
  { context: "overlay:keys-submode", keys: ["backspace"], owner: "ApiKeysManager", action: "delete character in input" },
  { context: "overlay:keys-submode", keys: ["a"],         owner: "ApiKeysManager", action: "select Anthropic provider" },
  { context: "overlay:keys-submode", keys: ["o"],         owner: "ApiKeysManager", action: "select OpenAI provider" },
  { context: "overlay:keys-submode", keys: ["g"],         owner: "ApiKeysManager", action: "select gateway provider" },
  { context: "overlay:keys-submode", keys: ["y"],         owner: "ApiKeysManager", action: "confirm delete" },
  { context: "overlay:keys-submode", keys: ["n"],         owner: "ApiKeysManager", action: "cancel delete" },

  // ── Overlay: metrics ──────────────────────────────────────────────────────
  { context: "overlay:metrics", keys: ["left", "right"], owner: "MetricsDashboard", action: "change period" },
  { context: "overlay:metrics", keys: ["r"],              owner: "MetricsDashboard", action: "toggle auto-refresh" },

  // ── Overlay: effort ───────────────────────────────────────────────────────
  { context: "overlay:effort", keys: ["up", "down"], owner: "EffortPicker", action: "navigate effort levels" },
  { context: "overlay:effort", keys: ["enter"],       owner: "EffortPicker", action: "select effort" },

  // ── Overlay: summary ──────────────────────────────────────────────────────
  { context: "overlay:summary", keys: ["up", "down"], owner: "SummaryPicker", action: "navigate formats" },
  { context: "overlay:summary", keys: ["enter"],       owner: "SummaryPicker", action: "select format" },

  // ── Overlay: planMode ─────────────────────────────────────────────────────
  { context: "overlay:planMode", keys: ["up", "down"], owner: "PlanModePicker", action: "navigate depths" },
  { context: "overlay:planMode", keys: ["enter"],       owner: "PlanModePicker", action: "select depth" },

  // ── Overlay: session (memory) ─────────────────────────────────────────────
  { context: "overlay:session", keys: ["up", "down"], owner: "SessionMemoryPicker", action: "navigate options" },
  { context: "overlay:session", keys: ["enter"],       owner: "SessionMemoryPicker", action: "select option / clear session" },

  // ── Overlay: sessions (browser) ───────────────────────────────────────────
  { context: "overlay:sessions", keys: ["up", "down"], owner: "SessionBrowser", action: "navigate sessions" },
  { context: "overlay:sessions", keys: ["enter"],       owner: "SessionBrowser", action: "resume session" },

  // ── Overlay: permissions ──────────────────────────────────────────────────
  { context: "overlay:permissions", keys: ["up", "down"], owner: "PermissionsManager", action: "navigate prefixes" },
  { context: "overlay:permissions", keys: ["delete", "backspace", "d"], owner: "PermissionsManager", action: "remove prefix" },

  // ── Overlay: limits ───────────────────────────────────────────────────────
  { context: "overlay:limits", keys: ["enter"],      owner: "LimitsEditor", action: "apply cap" },
  { context: "overlay:limits", keys: ["backspace"],   owner: "LimitsEditor", action: "delete digit" },
  { context: "overlay:limits", keys: ["."],           owner: "LimitsEditor", action: "decimal point" },

  // ── Overlay: commit ───────────────────────────────────────────────────────
  { context: "overlay:commit", keys: ["enter"],      owner: "CommitEditor", action: "execute commit" },
  { context: "overlay:commit", keys: ["backspace"],   owner: "CommitEditor", action: "delete character in message" },

  // ── Overlay: feedback ─────────────────────────────────────────────────────
  { context: "overlay:feedback", keys: ["enter"],     owner: "FeedbackForm", action: "send feedback" },
  { context: "overlay:feedback", keys: ["backspace"],  owner: "FeedbackForm", action: "delete character in message" },
  { context: "overlay:feedback", keys: ["m"],          owner: "FeedbackForm", action: "open email draft (delivered state)" },

  // ── Overlay: undo ─────────────────────────────────────────────────────────
  { context: "overlay:undo", keys: ["y", "enter"], owner: "UndoConfirm", action: "confirm undo" },
  { context: "overlay:undo", keys: ["n"],           owner: "UndoConfirm", action: "cancel undo" },

  // ── Overlay: trust ────────────────────────────────────────────────────────
  { context: "overlay:trust", keys: ["y"], owner: "TrustPrompt", action: "trust folder" },
  { context: "overlay:trust", keys: ["n"], owner: "TrustPrompt", action: "don't trust folder" },

  // ── Overlay: hookTrust ────────────────────────────────────────────────────
  { context: "overlay:hookTrust", keys: ["y"], owner: "HookTrustPrompt", action: "approve hooks" },
  { context: "overlay:hookTrust", keys: ["n"], owner: "HookTrustPrompt", action: "disable hooks" },

  // ── Overlay: mcpTrust ─────────────────────────────────────────────────────
  { context: "overlay:mcpTrust", keys: ["y"], owner: "McpTrustPrompt", action: "approve MCP servers" },
  { context: "overlay:mcpTrust", keys: ["n"], owner: "McpTrustPrompt", action: "disable MCP servers" },

  // ── Modal: approval ───────────────────────────────────────────────────────
  { context: "modal:approval", keys: ["y"],          owner: "ApprovalModal", action: "approve command" },
  { context: "modal:approval", keys: ["n"],          owner: "ApprovalModal", action: "deny command" },
  { context: "modal:approval", keys: ["t"],          owner: "ApprovalModal", action: "trust prefix permanently" },
  { context: "modal:approval", keys: ["escape"],     owner: "ApprovalModal", action: "deny command (same as n)" },

  // ── Modal: plan (revision) ────────────────────────────────────────────────
  { context: "modal:plan", keys: ["y"],       owner: "PlanModal", action: "approve plan" },
  { context: "modal:plan", keys: ["n"],       owner: "PlanModal", action: "reject plan and abort" },

  // ── Modal: staged diffs ───────────────────────────────────────────────────
  { context: "modal:stagedDiffs", keys: ["1"],          owner: "StagedDiffModal", action: "approve all" },
  { context: "modal:stagedDiffs", keys: ["2"],          owner: "StagedDiffModal", action: "manually approve" },
  { context: "modal:stagedDiffs", keys: ["3"],          owner: "StagedDiffModal", action: "give feedback" },
  { context: "modal:stagedDiffs", keys: ["escape"],     owner: "StagedDiffModal", action: "reject and abort / cancel feedback" },
  { context: "modal:stagedDiffs", keys: ["enter"],      owner: "StagedDiffModal", action: "submit feedback" },
  { context: "modal:stagedDiffs", keys: ["backspace"],  owner: "StagedDiffModal", action: "delete character in feedback" },
  { context: "modal:stagedDiffs", keys: ["left", "right"], owner: "StagedDiffModal", action: "move cursor in feedback" },

  // ── PlanActionPrompt (plan-ready) ─────────────────────────────────────────
  { context: "planReady", keys: ["1"],       owner: "PlanActionPrompt", action: "auto-accept all / answer now" },
  { context: "planReady", keys: ["2"],       owner: "PlanActionPrompt", action: "manually approve changes" },
  { context: "planReady", keys: ["3"],       owner: "PlanActionPrompt", action: "give feedback / plan a fix" },
  { context: "planReady", keys: ["4"],       owner: "PlanActionPrompt", action: "feedback + run" },
  { context: "planReady", keys: ["escape"],  owner: "PlanActionPrompt", action: "reject plan + abort / cancel feedback" },
  { context: "planReady", keys: ["enter"],   owner: "PlanActionPrompt", action: "submit feedback" },
  { context: "planReady", keys: ["backspace"], owner: "PlanActionPrompt", action: "delete character in feedback" },
  { context: "planReady", keys: ["left", "right"], owner: "PlanActionPrompt", action: "move cursor in feedback" },
];
