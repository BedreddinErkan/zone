import { Box, Text, useInput, usePaste, useStdout } from "ink";
import { useState, useEffect, useMemo, useRef } from "react";
import fg from "fast-glob";
import { readAtFileContext } from "../atFileContext.js";
import { useStore } from "../store.js";
import { loadDiskTrust } from "../../../api/diskTrust.js";
import { loadDiskKeys } from "../../../api/diskKeys.js";
import { listSessionsMeta } from "../../../api/diskSessions.js";
import { runInit } from "../init.js";
import { readMemoryAndShow } from "../memory.js";
import { randomUUID } from "node:crypto";
import { saveDiskModel, type DiskModelSettings } from "../../../api/diskModel.js";
import { getDefaultModelId, supportsVision } from "../../../llm/modelRegistry.js";
import { readImageFromFile, validateAttachments, type ImageAttachment } from "../../../api/imageUpload.js";
import { basename } from "node:path";

const MAX_HISTORY = 50;

interface ComposerProps {
  onSubmit: (text: string, ac: AbortController, images?: ImageAttachment[]) => void;
  onExit: () => void;
  onInitStart?: (ac: AbortController) => void;
  onUndoRequest?: () => void;
  getCommitData?: () => { filePaths: string[]; message: string; repoPath: string } | null;
}

interface SlashCommand {
  name: string;
  desc: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help",        desc: "Show key bindings and commands" },
  { name: "/exit",        desc: "Exit zone" },
  { name: "/clear",       desc: "Clear transcript" },
  { name: "/cost",        desc: "Show session cost" },
  { name: "/permissions", desc: "View and remove trusted command prefixes" },
  { name: "/keys",        desc: "Manage API keys (BYOK)" },
  { name: "/sessions",   desc: "Browse and resume past sessions" },
  { name: "/init",       desc: "Scaffold .zone/memory.md by analyzing repo" },
  { name: "/memory",     desc: "Show .zone/memory.md" },
  { name: "/model",      desc: "Choose AI model" },
  { name: "/effort",     desc: "Set reasoning effort (model-dependent: low → max)" },
  { name: "/summary",   desc: "Set summary format (compact/detailed)" },
  { name: "/plan-mode", desc: "Set plan depth (quick/investigate)" },
  { name: "/session",   desc: "Toggle session memory (off/on)" },
  { name: "/metrics",   desc: "View run telemetry KPIs" },
  { name: "/limits",   desc: "Set daily USD cap" },
  { name: "/commit",      desc: "Commit last run's changes with scoped git commit" },
  { name: "/autocommit",  desc: "Toggle auto-commit after each run (off/on)" },
  { name: "/websearch",   desc: "Toggle web search (off/on)" },
  { name: "/image",       desc: "Attach a local image file to the next task (/image <path>)" },
  { name: "/undo",        desc: "Undo the last run (restore files to pre-run state)" },
];

const HELP_LINES = [
  "Key bindings:",
  "  Enter       submit prompt",
  "  \\+Enter     insert newline (multiline)",
  "  Esc         clear input / abort run",
  "  Ctrl+C      exit zone",
  "  ↑/↓         navigate history (when input empty)",
  "  ←/→ Home End  cursor movement",
  "Slash commands:",
  "  /help  /clear  /cost  /exit  /permissions  /keys  /sessions  /init  /memory  /model  /effort  /summary  /plan-mode  /session  /metrics  /limits  /commit  /autocommit  /websearch  /image  /undo",
];

const PUA_BASE = 0xe000;
/** @internal exported for tests */
export const PUA_STRIP_RE = /[\uE000-\uF8FF]/g;
const PASTE_THRESHOLD_LINES = 6;
const PASTE_THRESHOLD_BYTES = 400;

type PasteEntry = { num: number; fullText: string; lines: number };

/** @internal exported for tests */
export function chipLabel(entry: PasteEntry): string {
  return `[Pasted text #${entry.num} +${entry.lines} lines]`;
}

/** @internal exported for tests */
export function expandSentinels(buf: string, sideMap: Map<string, PasteEntry>): string {
  let result = "";
  for (const ch of buf) {
    const entry = sideMap.get(ch);
    result += entry ? chipLabel(entry) : ch;
  }
  return result;
}

/** @internal exported for tests */
export function renderBuffer(buf: string, pos: number, sideMap: Map<string, PasteEntry>): string {
  return expandSentinels(buf.slice(0, pos), sideMap) + "▋" + expandSentinels(buf.slice(pos), sideMap);
}

interface PaletteProps {
  commands: SlashCommand[];
  selectedIdx: number;
}

function SlashCommandPalette({ commands, selectedIdx }: PaletteProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {commands.map((cmd, i) => (
        <Box key={cmd.name}>
          <Text color={i === selectedIdx ? "cyan" : undefined}>
            {cmd.name}{"  "}
          </Text>
          <Text dimColor>{cmd.desc}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function Composer({ onSubmit, onExit, onInitStart, onUndoRequest, getCommitData }: ComposerProps): React.ReactElement {
  const { state, dispatch } = useStore();
  const { stdout } = useStdout();
  const disabled = state.runState === "running";

  // Dedup: user commands whose names don't collide with any built-in.
  // Built-ins always win — this list is used for BOTH palette and execution.
  const projectCommands = useMemo(
    () => state.userCommands.filter(uc => !SLASH_COMMANDS.some(b => b.name === uc.name)),
    [state.userCommands]
  );

  // Merged command list for the palette filter/match/display.
  const allCommands: SlashCommand[] = useMemo(
    () => [
      ...SLASH_COMMANDS,
      ...projectCommands.map(uc => ({
        name: uc.name,
        desc: `(project) ${uc.description.length > 49
          ? uc.description.slice(0, 46) + "…"
          : uc.description}`,
      })),
    ],
    [projectCommands]
  );

  const [buffer, setBuffer] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);   // -1 = live input
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [atFiles, setAtFiles] = useState<string[]>([]);
  const [atIdx, setAtIdx] = useState(0);
  const sideMapRef = useRef<Map<string, PasteEntry>>(new Map());
  const pasteCounterRef = useRef(1);
  const lastAtSelectedPath = useRef<string | null>(null);
  const [stagedImages, setStagedImages] = useState<ImageAttachment[]>([]);

  const atPaletteOpen = buffer.startsWith("@") && !buffer.slice(1).includes(" ");
  const paletteOpen = buffer.startsWith("/");
  const paletteFilter = paletteOpen ? buffer.slice(1).toLowerCase() : "";

  useEffect(() => {
    if (!atPaletteOpen) { setAtFiles([]); return; }
    lastAtSelectedPath.current = null;
    const query = buffer.slice(1);
    const pattern = query ? `**/*${query}*` : "**/*";
    fg(pattern, { cwd: process.cwd(), ignore: ["**/node_modules/**", "**/.git/**"], onlyFiles: true, dot: false, suppressErrors: true })
      .then(files => { setAtFiles(files.slice(0, 20)); setAtIdx(0); })
      .catch(() => setAtFiles([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atPaletteOpen, buffer]);
  const filteredCommands = allCommands.filter((c) =>
    c.name.slice(1).startsWith(paletteFilter)
  );

  function executeSlashCommand(name: string, argsText: string = ""): void {
    setBuffer("");
    setCursorPos(0);
    setHistoryIdx(-1);
    setPaletteIdx(0);

    // Project-command lookup. Uses projectCommands (not raw state.userCommands) so a name
    // colliding with a built-in falls through to the switch — built-ins can never be shadowed.
    const userCmd = projectCommands.find(uc => uc.name === name);
    if (userCmd) {
      if (disabled) {
        dispatch({ type: "USER_PROMPT", text: `Cannot run ${name} while a run is in progress.` });
        return;
      }
      const substituted = userCmd.body.replaceAll("$ARGUMENTS", argsText);
      dispatch({ type: "USER_PROMPT", text: substituted });
      const ac = new AbortController();
      onSubmit(substituted, ac); // same two lines as submitBuffer — mode injected by App
      return;
    }

    switch (name) {
      case "/help":
        for (const line of HELP_LINES) {
          dispatch({ type: "USER_PROMPT", text: line });
        }
        break;
      case "/exit":
        onExit();
        break;
      case "/clear":
        dispatch({ type: "TRANSCRIPT_CLEAR" });
        break;
      case "/cost": {
        const { costUsd, iter, model } = state.statusBar;
        dispatch({
          type: "USER_PROMPT",
          text: `Cost: $${costUsd.toFixed(4)}  Iters: ${iter}  Model: ${model || "default"}`,
        });
        break;
      }
      case "/permissions":
        void loadDiskTrust(process.cwd()).then(store => {
          dispatch({ type: "PERMISSIONS_OPEN", list: store.trustedPrefixes });
        });
        break;
      case "/keys":
        void loadDiskKeys().then(store => {
          dispatch({ type: "KEYS_OPEN", list: store.keys });
        });
        break;
      case "/sessions":
        if (disabled) {
          dispatch({
            type: "USER_PROMPT",
            text: "Cannot switch sessions while a run is in progress; press Esc to abort first",
          });
          break;
        }
        void listSessionsMeta(process.cwd()).then(list => {
          dispatch({ type: "SESSIONS_OPEN", list });
        });
        break;
      case "/init":
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot /init while a run is in progress." });
          break;
        }
        {
          const ac = new AbortController();
          onInitStart?.(ac);
          void runInit(process.cwd(), dispatch, ac);
        }
        break;
      case "/memory":
        void readMemoryAndShow(process.cwd(), dispatch);
        break;
      case "/model":
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot change /model while a run is in progress." });
          break;
        }
        dispatch({ type: "MODEL_MODAL_OPEN" });
        break;
      case "/effort":
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot change /effort while a run is in progress." });
          break;
        }
        dispatch({ type: "EFFORT_MODAL_OPEN" });
        break;
      case "/summary":
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot change /summary while a run is in progress." });
          break;
        }
        dispatch({ type: "SUMMARY_MODAL_OPEN" });
        break;
      case "/plan-mode":
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot change /plan-mode while a run is in progress." });
          break;
        }
        dispatch({ type: "PLANMODE_MODAL_OPEN" });
        break;
      case "/session":
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot change /session while a run is in progress." });
          break;
        }
        dispatch({ type: "MEMORY_MODAL_OPEN" });
        break;
      case "/metrics":
        dispatch({ type: "METRICS_MODAL_OPEN" });
        break;
      case "/limits":
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot change /limits while a run is in progress." });
          break;
        }
        dispatch({ type: "LIMITS_MODAL_OPEN" });
        break;
      case "/commit": {
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot /commit while a run is in progress." });
          break;
        }
        const commitData = getCommitData?.();
        if (!commitData || commitData.filePaths.length === 0) {
          dispatch({ type: "USER_PROMPT", text: "Nothing to commit — run a task first." });
          break;
        }
        dispatch({ type: "COMMIT_MODAL_OPEN", filePaths: commitData.filePaths, message: commitData.message, repoPath: commitData.repoPath });
        break;
      }
      case "/autocommit": {
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot change /autocommit while a run is in progress." });
          break;
        }
        const currentVal = state.modelSettings?.commitOnSuccess ?? false;
        const newVal = !currentVal;
        const currentModel = state.modelSettings?.model ?? getDefaultModelId();
        const updated: DiskModelSettings = state.modelSettings
          ? { ...state.modelSettings, commitOnSuccess: newVal, updatedAt: new Date().toISOString() }
          : { version: 2, model: currentModel, provider: "anthropic", commitOnSuccess: newVal, updatedAt: new Date().toISOString() };
        void saveDiskModel(process.cwd(), updated);
        dispatch({ type: "AUTOCOMMIT_APPLY", commitOnSuccess: newVal });
        dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: `Auto-commit: ${newVal ? "on" : "off"}`, level: "info" } });
        break;
      }
      case "/websearch": {
        if (disabled) {
          dispatch({ type: "USER_PROMPT", text: "Cannot change /websearch while a run is in progress." });
          break;
        }
        const currentVal = state.modelSettings?.webSearchEnabled ?? true;  // absence = ON
        const newVal = !currentVal;
        const currentModel = state.modelSettings?.model ?? getDefaultModelId();
        const updated: DiskModelSettings = state.modelSettings
          ? { ...state.modelSettings, webSearchEnabled: newVal, updatedAt: new Date().toISOString() }
          : { version: 2, model: currentModel, provider: "anthropic", webSearchEnabled: newVal, updatedAt: new Date().toISOString() };
        void saveDiskModel(process.cwd(), updated);
        dispatch({ type: "WEBSEARCH_APPLY", webSearchEnabled: newVal });
        dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: `Web search: ${newVal ? "on" : "off"}`, level: "info" } });
        break;
      }
      case "/image": {
        if (!argsText) {
          dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: "Usage: /image <path>", level: "warning" } });
          break;
        }
        readImageFromFile(argsText)
          .then((img) => {
            const validation = validateAttachments([img]);
            if (!validation.ok) {
              dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: validation.error, level: "warning" } });
              return;
            }
            setStagedImages((prev) => [...prev, img]);
            dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: `Image staged: ${basename(argsText)}`, level: "info" } });
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: msg, level: "warning" } });
          });
        break;
      }
      case "/undo": {
        onUndoRequest?.();
        break;
      }
    }
  }

  async function submitBuffer(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Single positional pass — expand sentinels to full text; never re-scans emitted content.
    let agentText = "";
    for (const ch of trimmed) {
      const entry = sideMapRef.current.get(ch);
      agentText += entry ? entry.fullText : ch;
    }

    setHistory((prev) => {
      const next = prev[0] === agentText ? prev : [agentText, ...prev].slice(0, MAX_HISTORY);
      return next;
    });
    setHistoryIdx(-1);

    // Capture staged images before any state changes; gate on vision support.
    const imagesToSend = stagedImages;
    if (imagesToSend.length > 0 && !supportsVision(state.statusBar.model)) {
      dispatch({ type: "TOAST_PUSH", entry: { id: randomUUID(), message: "Current model doesn't support images — switch to a vision-capable model", level: "warning" } });
      return;
    }

    dispatch({ type: "USER_PROMPT", text: agentText });
    setBuffer("");
    setStagedImages([]);
    setCursorPos(0);
    sideMapRef.current.clear();
    pasteCounterRef.current = 1;

    let contextBlock = "";
    const fp = lastAtSelectedPath.current;
    if (fp && agentText.includes(fp)) {
      lastAtSelectedPath.current = null;
      const fileCtx = await readAtFileContext(fp);
      if (fileCtx) contextBlock = `\n\n[User-attached file]\n${fileCtx}`;
    }

    const ac = new AbortController();
    onSubmit(agentText + contextBlock, ac, imagesToSend.length > 0 ? imagesToSend : undefined);
  }

  useInput((input, key) => {
    // Block all input when approval modal or permissions view is active
    if (state.pendingApproval !== null || state.modalView !== "none") return;

    // ── @ file-completion palette — available whenever palette is open ──
    if (atPaletteOpen && atFiles.length > 0) {
      if (key.upArrow) { setAtIdx(i => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setAtIdx(i => Math.min(atFiles.length - 1, i + 1)); return; }
      if (key.return || key.tab) {
        const selected = atFiles[atIdx];
        if (selected) {
          lastAtSelectedPath.current = selected;
          setBuffer(selected);
          setCursorPos(selected.length);
        }
        setAtFiles([]);
        return;
      }
      if (key.escape) { setAtFiles([]); return; }
    }

    // ── Slash-command path — always available, even during a running task ──
    if (paletteOpen && filteredCommands.length > 0) {
      if (key.upArrow) {
        setPaletteIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setPaletteIdx((i) => Math.min(filteredCommands.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const cmd = filteredCommands[paletteIdx];
        if (cmd) executeSlashCommand(cmd.name);
        return;
      }
      if (key.escape) {
        setBuffer("");
        setCursorPos(0);
        setPaletteIdx(0);
        return;
      }
    }
    if (key.return && allCommands.some((c) => c.name === buffer)) {
      executeSlashCommand(buffer);
      return;
    }
    if (key.return) {
      const spaceIdx = buffer.indexOf(" ");
      if (spaceIdx !== -1) {
        const commandToken = buffer.slice(0, spaceIdx);
        if (commandToken === "/image") {
          executeSlashCommand("/image", buffer.slice(spaceIdx + 1).trim());
          return;
        }
        if (projectCommands.some(uc => uc.name === commandToken)) {
          executeSlashCommand(commandToken, buffer.slice(spaceIdx + 1).trim());
          return;
        }
      }
    }

    // ── During a run: only slash-buffer editing allowed ──
    if (disabled) {
      if (key.escape) {
        setBuffer("");
        setCursorPos(0);
        setHistoryIdx(-1);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          const newBuf = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
          setBuffer(newBuf);
          setCursorPos(cursorPos - 1);
          setHistoryIdx(-1);
        }
        return;
      }
      if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32) {
        if (buffer === "" || buffer.startsWith("/")) {
          const newBuf = buffer.slice(0, cursorPos) + input + buffer.slice(cursorPos);
          setBuffer(newBuf);
          setCursorPos(cursorPos + input.length);
          setHistoryIdx(-1);
          if (paletteOpen) setPaletteIdx(0);
        }
      }
      return;
    }

    // ── Full input path (only when not running) ──
    if (key.return) {
      // Multiline: trailing backslash → insert newline
      if (buffer.endsWith("\\")) {
        const newBuf = buffer.slice(0, -1) + "\n";
        setBuffer(newBuf);
        setCursorPos(newBuf.length);
        return;
      }
      void submitBuffer(buffer);
      return;
    }

    if (key.escape) {
      if (buffer) {
        setBuffer("");
        setCursorPos(0);
        setHistoryIdx(-1);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        const newBuf = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
        setBuffer(newBuf);
        setCursorPos(cursorPos - 1);
        setHistoryIdx(-1);
      }
      return;
    }

    if (key.leftArrow) {
      setCursorPos((p) => Math.max(0, p - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorPos((p) => Math.min(buffer.length, p + 1));
      return;
    }
    if (key.home) {
      setCursorPos(0);
      return;
    }
    if (key.end) {
      setCursorPos(buffer.length);
      return;
    }

    // History navigation (only when buffer is empty or navigating)
    if (key.upArrow) {
      const nextIdx = historyIdx + 1;
      if (nextIdx < history.length) {
        const entry = history[nextIdx];
        setBuffer(entry);
        setCursorPos(entry.length);
        setHistoryIdx(nextIdx);
      }
      return;
    }
    if (key.downArrow) {
      if (historyIdx > 0) {
        const nextIdx = historyIdx - 1;
        const entry = history[nextIdx];
        setBuffer(entry);
        setCursorPos(entry.length);
        setHistoryIdx(nextIdx);
      } else if (historyIdx === 0) {
        setBuffer("");
        setCursorPos(0);
        setHistoryIdx(-1);
      }
      return;
    }

    // Printable character input — handles single keypresses and multi-char pastes.
    // charCodeAt(0) >= 32 excludes control chars; ctrl/meta guard excludes chords.
    if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32) {
      const cleaned = input.replace(PUA_STRIP_RE, "");
      if (cleaned) {
        const newBuf = buffer.slice(0, cursorPos) + cleaned + buffer.slice(cursorPos);
        setBuffer(newBuf);
        setCursorPos(cursorPos + cleaned.length);
        setHistoryIdx(-1);
        if (paletteOpen) setPaletteIdx(0);
      }
    }
  });

  usePaste((text) => {
    if (state.pendingApproval !== null || state.modalView !== "none") return;
    if (disabled && !(buffer.startsWith("/") || (!buffer && text.startsWith("/")))) return;

    const lines = text.split("\n").length;
    const bytes = Buffer.byteLength(text);

    if (lines >= PASTE_THRESHOLD_LINES || bytes >= PASTE_THRESHOLD_BYTES) {
      const num = pasteCounterRef.current;
      pasteCounterRef.current = num + 1;
      const sentinel = String.fromCharCode(PUA_BASE + num - 1);
      sideMapRef.current.set(sentinel, { num, fullText: text, lines });
      const newBuf = buffer.slice(0, cursorPos) + sentinel + buffer.slice(cursorPos);
      setBuffer(newBuf);
      setCursorPos(cursorPos + 1);
    } else {
      const cleaned = text.replace(PUA_STRIP_RE, "");
      const newBuf = buffer.slice(0, cursorPos) + cleaned + buffer.slice(cursorPos);
      setBuffer(newBuf);
      setCursorPos(cursorPos + cleaned.length);
    }
    setHistoryIdx(-1);
  }, { isActive: true });

  const displayBuffer = disabled
    ? expandSentinels(buffer, sideMapRef.current)
    : renderBuffer(buffer, cursorPos, sideMapRef.current);

  return (
    <Box flexDirection="column">
      {atPaletteOpen && atFiles.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {atFiles.map((f, i) => (
            <Text key={f} color={i === atIdx ? "cyan" : undefined}>{f}</Text>
          ))}
        </Box>
      )}
      {paletteOpen && filteredCommands.length > 0 && (
        <SlashCommandPalette commands={filteredCommands} selectedIdx={paletteIdx} />
      )}
      <Box backgroundColor="blackBright" paddingX={2} width={stdout.columns ?? 80}>
        <Text dimColor={disabled}>{disabled ? "  " : "> "}</Text>
        <Box flexGrow={1}>
          <Text dimColor={disabled}>{displayBuffer}</Text>
          {!disabled && !buffer && (
            <Text dimColor>{"Type a task or /help"}</Text>
          )}
        </Box>
      </Box>
      {stagedImages.length > 0 && (
        <Text dimColor>{`  [${stagedImages.length} image${stagedImages.length === 1 ? "" : "s"} staged]`}</Text>
      )}
    </Box>
  );
}
