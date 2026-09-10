import React from "react";
import { Box, Text, useInput } from "ink";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { useState } from "react";
import { useStore } from "../store.js";
import { role, glyph, spacing } from "../theme.js";

const execFileAsync = promisify(execFile);

export async function executeCommit(
  repoPath: string,
  message: string,
  filePaths: string[]
): Promise<{ ok: true; hash: string } | { ok: false; error: string }> {
  const opts = { cwd: repoPath, windowsHide: true };
  try {
    await execFileAsync("git", ["add", "--", ...filePaths], opts);
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, error: (e.stderr || e.stdout || String(err)).trim() };
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["commit", "-m", message, "--", ...filePaths],
      opts
    );
    const match = stdout.match(/\[[\w/]+ ([a-f0-9]+)\]/);
    return { ok: true, hash: match?.[1] ?? "ok" };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, error: (e.stderr || e.stdout || String(err)).trim() };
  }
}

/**
 * Phase 2d — content-only commit editor. No border, no title, no footer hints — those
 * come from OverlayShell when OverlayLayer wraps this component. Reads commitData from
 * the store; dispatches OVERLAY_POP on Esc/close.
 */
export function CommitEditor(): React.ReactElement {
  const { state, dispatch } = useStore();
  const data = state.commitData!;
  const [draftMsg, setDraftMsg] = useState(data.message);
  const [status, setStatus] = useState<"editing" | "running" | "error">("editing");
  const [errorMsg, setErrorMsg] = useState("");

  useInput((input, key) => {
    if (status === "running") return;
    // Esc falls through to central handler (Phase 3b).
    if (key.return) {
      if (!draftMsg.trim()) return;
      setStatus("running");
      void executeCommit(data.repoPath, draftMsg.trim(), data.filePaths).then(r => {
        if (r.ok) {
          dispatch({ type: "OVERLAY_POP" });
          dispatch({
            type: "TOAST_PUSH",
            entry: { id: randomUUID(), message: `Committed: ${r.hash}`, level: "info" },
          });
        } else {
          setStatus("error");
          setErrorMsg(r.error);
        }
      });
      return;
    }
    if (key.backspace || key.delete) {
      setDraftMsg(m => m.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setDraftMsg(m => m + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Text dimColor> Files:</Text>
      {data.filePaths.map(fp => (
        <Text key={fp} dimColor>   · {fp}</Text>
      ))}
      <Box marginTop={spacing.sm}>
        <Text> Message:</Text>
      </Box>
      <Text>   {draftMsg}{glyph.cursor}</Text>
      {status === "error" && (
        <Text color={role.danger}>  {errorMsg}</Text>
      )}
      {status === "running" && <Text dimColor> Committing…</Text>}
    </Box>
  );
}
