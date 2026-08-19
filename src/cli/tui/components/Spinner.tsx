import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { useStore } from "../store.js";
import { SPINNER_LABEL_STARTING, SPINNER_LABEL_PLANNING } from "../hooks/useAgentEvents.js";
import { role } from "../theme.js";

const FRAMES = ["✦", "✧", "✶", "✷", "✸", "✹", "✺", "✶"];
const FRAME_MS = 100;

export const LABEL_ROTATE_MS = 2000;
export const RUNNING_WORDS = [SPINNER_LABEL_STARTING, "Working…", "Crafting…", "Composing…", "Tinkering…", "Wiring…"];
const PLANNING_WORDS = [SPINNER_LABEL_PLANNING, "Thinking…", "Mapping…", "Scoping…", "Surveying…"];
const ROTATABLE: Record<string, string[]> = {
  [SPINNER_LABEL_STARTING]: RUNNING_WORDS,
  [SPINNER_LABEL_PLANNING]: PLANNING_WORDS,
};

export function Spinner(): React.ReactElement | null {
  const { state } = useStore();
  const [frame, setFrame] = useState(0);
  const [labelIdx, setLabelIdx] = useState(0);

  useEffect(() => {
    if (!state.spinner?.active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, [state.spinner?.active]);

  useEffect(() => {
    setLabelIdx(0);
    if (!state.spinner?.active) return;
    const words = ROTATABLE[state.spinner.label ?? ""];
    if (!words) return;
    const id = setInterval(() => setLabelIdx(i => i + 1), LABEL_ROTATE_MS);
    return () => clearInterval(id);
  }, [state.spinner?.active, state.spinner?.label]);

  if (!state.spinner || !state.spinner.active) return null;

  const label = state.spinner.label ?? "";
  const words = ROTATABLE[label];
  const displayLabel = words ? words[labelIdx % words.length] : label;

  return <Text bold color={role.activity}>{FRAMES[frame]}{displayLabel ? ` ${displayLabel}` : ""}</Text>;
}
