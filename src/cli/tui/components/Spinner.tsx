import React, { useState, useEffect } from "react";
import { Text } from "ink";
import { useStore } from "../store.js";

const FRAMES = ["✦", "✧", "✶", "✷", "✸", "✹", "✺", "✶"];
const FRAME_MS = 100;

export function Spinner(): React.ReactElement | null {
  const { state } = useStore();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!state.spinner?.active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, [state.spinner?.active]);

  if (!state.spinner?.active) return null;

  return <Text bold color="magenta">{FRAMES[frame]}</Text>;
}
