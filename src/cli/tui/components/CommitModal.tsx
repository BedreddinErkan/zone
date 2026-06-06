import { Box, Text, useInput, useStdout } from "ink";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { useState } from "react";
import type { Dispatch } from "react";
import { useStore } from "../store.js";
import type { StoreAction } from "../store.js";

const execFileAsync = promisify(execFile);

interface Props {
  dispatch: Dispatch<StoreAction>;
}

export async function executeCommit(
  repoPath: string,
  message: string,
  filePaths: string[]
): Promise<{ ok: true; hash: string } | { ok: false; error: string }> {
  const opts = { cwd: repoPath, windowsHide: true };
  // Step 1: stage exactly the run's files (new + modified + deletions).
  // Scoped via -- <paths> — NEVER "git add ." and NEVER -A.
  try {
    await execFileAsync("git", ["add", "--", ...filePaths], opts);
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    return { ok: false, error: (e.stderr || e.stdout || String(err)).trim() };
  }
  // Step 2: commit only those paths. The pathspec -- <paths> puts git in
  // "only these paths" mode so pre-existing staged changes are not swept in.
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

export function CommitModal({ dispatch }: Props): React.ReactElement {
  const { state } = useStore();
  const { stdout } = useStdout();
  const data = state.commitData!;
  const [draftMsg, setDraftMsg] = useState(data.message);
  const [status, setStatus] = useState<"editing" | "running" | "error">("editing");
  const [errorMsg, setErrorMsg] = useState("");

  useInput((input, key) => {
    if (status === "running") return;
    if (key.escape) {
      dispatch({ type: "COMMIT_MODAL_CLOSE" });
      return;
    }
    if (key.return) {
      if (!draftMsg.trim()) return;
      setStatus("running");
      void executeCommit(data.repoPath, draftMsg.trim(), data.filePaths).then(r => {
        if (r.ok) {
          dispatch({ type: "COMMIT_MODAL_CLOSE" });
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

  const cols = stdout?.columns ?? process.stdout.columns ?? 80;
  const innerWidth = Math.min(cols - 4, 70);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      width={innerWidth}
    >
      <Text bold color="cyan"> Commit changes</Text>
      <Text> </Text>
      <Text dimColor> Files:</Text>
      {data.filePaths.map(fp => (
        <Text key={fp} dimColor>   · {fp}</Text>
      ))}
      <Text> </Text>
      <Text> Message:</Text>
      <Text>   {draftMsg}▋</Text>
      <Text> </Text>
      {status === "error" && (
        <Text color="red">  {errorMsg}</Text>
      )}
      {status === "running"
        ? <Text dimColor> Committing…</Text>
        : <Text dimColor> Type message · Enter commit · Esc cancel</Text>
      }
    </Box>
  );
}
