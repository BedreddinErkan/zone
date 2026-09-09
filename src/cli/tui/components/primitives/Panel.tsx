import React from "react";
import { Box, Text, useStdout } from "ink";
import { role, spacing, width as widthTokens } from "../../theme.js";

export type PanelProps = {
  /** Optional header line. Omitted = no header row (just a bordered content block). */
  title?: string;
  borderStyle?: "round" | "single" | "double";
  borderColor?: string;
  width?: "narrow" | "wide" | "full";
  children: React.ReactNode;
};

/**
 * Non-modal inline panel. Thinner than OverlayShell — no footer, no keyHints, no onClose
 * contract — intended for inline content blocks (PlanPanel, QuestionPanel in the current
 * tree) rather than overlays. OverlayShell is composed from Panel's shape plus KeyHints;
 * the split keeps modal chrome and inline chrome from silently coupling.
 *
 * Pure presentation. No useInput, no store, no dispatch.
 */
export function Panel({
  title,
  borderStyle = "round",
  borderColor = role.accent,
  width: widthPolicy = "wide",
  children,
}: PanelProps): React.ReactElement {
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
    >
      {title != null && (
        <Box>
          <Text bold color={role.emphasis}>
            {title.toLowerCase()}
          </Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={title != null ? spacing.sm : spacing.xs}>
        {children}
      </Box>
    </Box>
  );
}
