import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { useStore } from "../store.js";
import { role, glyph } from "../theme.js";

// The logo mark's own diagonal (╱, matched to the landing SVG's stroke direction), rotating
// through the natural box-drawing line family — 45°, 90°, 135°, 180°. The palette pass. The
// 180° frame reuses glyph.separator rather than a local box-drawing-horizontal literal: that
// exact character is already claimed there, and themeCoverage.test.ts forbids a disconnected
// second copy of an already-extracted glyph.
const FRAMES = ["╱", "│", "╲", glyph.separator];
const FRAME_MS = 100;

export function Spinner(): React.ReactElement | null {
  const { state } = useStore();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!state.spinner?.active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, [state.spinner?.active]);

  if (!state.spinner || !state.spinner.active) return null;

  const label = state.spinner.label ?? "";

  return <Text bold color={role.activity}>{FRAMES[frame]}{label ? ` ${label}` : ""}</Text>;
}
