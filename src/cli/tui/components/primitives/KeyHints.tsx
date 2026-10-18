import React from "react";
import { Text } from "ink";
import { role } from "../../theme.js";

export type KeyHint = {
  key: string;
  label: string;
  /** Primary hints render in role.emphasis; secondary in role.muted. The distinction is
   *  the same one the existing modals already make (confirm/dismiss vs. navigate) — encoded
   *  as a single boolean rather than a free-form role string, so a new "tertiary" tier
   *  becomes a visible edit instead of a silent enum extension. */
  primary?: boolean;
};

/**
 * One-line footer of `key label · key label · ...` hint pairs. Pure presentation: no useInput,
 * no store access, no dispatch. The `·` separator is a hard-coded glyph rather than a theme
 * entry — it is the sole consumer and extracting it would be a name for a single literal.
 *
 * Empty `items` renders nothing (not an empty Box): an overlay with no hints should leave no
 * footprint, not a blank line — Phase 2c/2d modals compose KeyHints into the footer slot and
 * some have no actions to advertise.
 */
export function KeyHints({ items, maxWidth, compactItems }: {
  items: KeyHint[];
  maxWidth?: number;
  compactItems?: KeyHint[];
}): React.ReactElement | null {
  if (items.length === 0) return null;
  // These shortcut labels are single-cell text. Choose complete hints before
  // rendering; sibling flex Text nodes otherwise squeeze each other's words.
  const length = (hints: KeyHint[]) => hints.reduce((n, h) => n + h.key.length + (h.label ? h.label.length + 1 : 0), 0)
    + Math.max(0, hints.length - 1) * 3;
  let visible = items;
  if (maxWidth !== undefined && length(visible) > maxWidth) {
    visible = compactItems ?? items.map(h => ({ ...h, label: h.primary ? h.label : "" }));
    if (length(visible) > maxWidth) visible = visible.map(h => ({ ...h, label: "" }));
  }
  const rendered: React.ReactNode[] = [];
  visible.forEach((hint, i) => {
    if (i > 0) {
      rendered.push(
        <Text key={`sep-${i}`} color={role.muted}>
          {" · "}
        </Text>
      );
    }
    const color = hint.primary ? role.emphasis : role.muted;
    rendered.push(
      <Text key={`hint-${i}`}>
        <Text bold color={color}>
          {hint.key}
        </Text>
        {hint.label && <Text color={color}>{" "}{hint.label}</Text>}
      </Text>
    );
  });
  return <Text>{rendered}</Text>;
}
