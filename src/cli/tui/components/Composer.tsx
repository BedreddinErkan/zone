import { Box, Text, useInput, usePaste } from "ink";
import { useState, useEffect } from "react";
import fg from "fast-glob";
import { useStore } from "../store.js";
import { loadDiskTrust } from "../../../api/diskTrust.js";
import { loadDiskKeys } from "../../../api/diskKeys.js";
import { listSessionsMeta } from "../../../api/diskSessions.js";
import { runInit } from "../init.js";
import { readMemoryAndShow } from "../memory.js";

const MAX_HISTORY = 50;

interface ComposerProps {
  onSubmit: (text: string, ac: AbortController) => void;
  onExit: () => void;
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
  { name: "/effort",     desc: "Set reasoning effort (low/medium/high)" },
  { name: "/metrics",   desc: "View run telemetry KPIs" },
  { name: "/limits",   desc: "Set daily USD cap" },
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
  "  /help  /clear  /cost  /exit  /permissions  /keys  /sessions  /init  /memory  /model  /effort  /metrics  /limits",
];

function renderBuffer(buf: string, pos: number): string {
  return buf.slice(0, pos) + "▋" + buf.slice(pos);
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

export function Composer({ onSubmit, onExit }: ComposerProps): React.ReactElement {
  const { state, dispatch } = useStore();
  const disabled = state.runState === "running";

  const [buffer, setBuffer] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);   // -1 = live input
  const [paletteIdx, setPaletteIdx] = useState(0);
  const [atFiles, setAtFiles] = useState<string[]>([]);
  const [atIdx, setAtIdx] = useState(0);

  const atPaletteOpen = buffer.startsWith("@") && !buffer.slice(1).includes(" ");
  const paletteOpen = buffer.startsWith("/");
  const paletteFilter = paletteOpen ? buffer.slice(1).toLowerCase() : "";

  useEffect(() => {
    if (!atPaletteOpen) { setAtFiles([]); return; }
    const query = buffer.slice(1);
    const pattern = query ? `**/*${query}*` : "**/*";
    fg(pattern, { cwd: process.cwd(), ignore: ["**/node_modules/**", "**/.git/**"], onlyFiles: true, dot: false, suppressErrors: true })
      .then(files => { setAtFiles(files.slice(0, 20)); setAtIdx(0); })
      .catch(() => setAtFiles([]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atPaletteOpen, buffer]);
  const filteredCommands = SLASH_COMMANDS.filter((c) =>
    c.name.slice(1).startsWith(paletteFilter)
  );

  function executeSlashCommand(name: string): void {
    setBuffer("");
    setCursorPos(0);
    setHistoryIdx(-1);
    setPaletteIdx(0);

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
        void runInit(process.cwd(), dispatch);
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
    }
  }

  function submitBuffer(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Push to history (dedupe consecutive identical entries)
    setHistory((prev) => {
      const next = prev[0] === trimmed ? prev : [trimmed, ...prev].slice(0, MAX_HISTORY);
      return next;
    });
    setHistoryIdx(-1);

    dispatch({ type: "USER_PROMPT", text: trimmed });
    setBuffer("");
    setCursorPos(0);

    const ac = new AbortController();
    onSubmit(trimmed, ac);
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
        if (selected) { setBuffer(selected); setCursorPos(selected.length); }
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
    if (key.return && SLASH_COMMANDS.some((c) => c.name === buffer)) {
      executeSlashCommand(buffer);
      return;
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
      submitBuffer(buffer);
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
      const newBuf = buffer.slice(0, cursorPos) + input + buffer.slice(cursorPos);
      setBuffer(newBuf);
      setCursorPos(cursorPos + input.length);
      setHistoryIdx(-1);
      if (paletteOpen) setPaletteIdx(0);
    }
  });

  usePaste((text) => {
    if (state.pendingApproval !== null || state.modalView !== "none") return;
    if (disabled && !(buffer.startsWith("/") || (!buffer && text.startsWith("/")))) return;
    const newBuf = buffer.slice(0, cursorPos) + text + buffer.slice(cursorPos);
    setBuffer(newBuf);
    setCursorPos(cursorPos + text.length);
    setHistoryIdx(-1);
  }, { isActive: true });

  const borderColor = disabled ? "gray" : "white";
  const displayBuffer = disabled ? buffer : renderBuffer(buffer, cursorPos);

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
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text dimColor={disabled}>{disabled ? "  " : "> "}</Text>
        <Box flexGrow={1}>
          <Text dimColor={disabled}>{displayBuffer}</Text>
          {!disabled && !buffer && (
            <Text dimColor>{"Type a task or /help"}</Text>
          )}
        </Box>
      </Box>
    </Box>
  );
}
