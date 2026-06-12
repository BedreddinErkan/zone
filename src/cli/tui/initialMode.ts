import type { TuiMode } from "./store.js";

/**
 * Map the CLI `--permission-mode <mode>` flag to the TUI's initial mode.
 * Only `plan` engages plan mode at launch; everything else (undefined,
 * `default`, `acceptEdits`, `bypassPermissions`, …) starts in normal mode.
 * Pure + dependency-free so it is unit-testable without rendering Ink.
 */
export function resolveInitialTuiMode(permissionMode: string | undefined): TuiMode {
  return permissionMode === "plan" ? "plan" : "normal";
}
