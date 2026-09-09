import React from "react";
import { Box, Text, useStdout } from "ink";
import { role, spacing, width as widthTokens } from "../../theme.js";
import { KeyHints, type KeyHint } from "./KeyHints.js";

export type OverlayShellProps = {
  /** Modal title. Rendered lowercased and in role.emphasis — the convention shared by every
   *  modal in the TUI tree today, encoded here so the 14 modals stop spelling it out locally. */
  title: string;
  /** Border style forwarded to Ink. Default "round" — the modal-chrome default — so a modal
   *  that doesn't care about the border shape gets the one every other modal uses. */
  borderStyle?: "round" | "single" | "double";
  /** Border color as a theme role. Default role.accent; yes/no risk modals pass role.caution. */
  borderColor?: string;
  /** Width policy from theme.ts width tokens. "wide" (≤110) is the default — most modals are
   *  form-style; narrow (≤72) is the reading-style exception; full is for transcript-aligned
   *  overlays. */
  width?: "narrow" | "wide" | "full";
  /** Footer hints rendered via KeyHints. Empty array hides the footer entirely. */
  keyHints?: KeyHint[];
  children: React.ReactNode;
  /** Exposed for callers to wire Esc handling externally — the central Esc handler lands in
   *  Phase 3b, so OverlayShell itself does NOT register useInput. Callers that need a close
   *  callback today (App.tsx's per-modal Esc wiring) read it from here. */
  onClose?: () => void;
};

// onClose is surfaced on the type but intentionally not destructured — it exists so callers can
// pass it through for external wiring without TypeScript rejecting an unused prop. Phase 3b
// consumes it via the central Esc handler; until then it's a no-op contract.
void 0;

/**
 * Modal shell: bordered Box with a title line, a children slot, and a footer KeyHints line.
 * Pure presentation — no useInput, no store, no dispatch. The Esc-close contract is owned by
 * the central handler (Phase 3b); this component is the *shape* the handler wraps.
 *
 * Layout: paddingX=spacing.md, paddingY=spacing.sm (the modal-chrome defaults measured
 * against the 14 modals this replaces); marginY=spacing.sm to separate the overlay from
 * neighbouring output. Title line is uppercase-styled lowercase text in role.emphasis.
 */
export function OverlayShell({
  title,
  borderStyle = "round",
  borderColor = role.accent,
  width: widthPolicy = "wide",
  keyHints = [],
  children,
}: OverlayShellProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 80;
  const computedWidth = widthTokens[widthPolicy](cols);
  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={borderColor}
      width={computedWidth}
      paddingX={spacing.md}
      paddingY={spacing.sm}
      marginY={spacing.sm}
    >
      <Box flexDirection="column">
        <Box>
          <Text bold color={role.emphasis}>
            {title.toLowerCase()}
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={spacing.sm}>
          {children}
        </Box>
        {keyHints.length > 0 && (
          <Box marginTop={spacing.sm}>
            <KeyHints items={keyHints} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
