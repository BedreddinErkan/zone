import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { useStore } from "../store.js";

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
  { name: "/help",  desc: "Show key bindings and commands" },
  { name: "/exit",  desc: "Exit zone" },
  { name: "/clear", desc: "Clear transcript" },
  { name: "/cost",  desc: "Show session cost" },
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
  "  /help  /clear  /cost  /exit",
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

  const paletteOpen = buffer.startsWith("/") && buffer.length > 1;
  const paletteFilter = paletteOpen ? buffer.slice(1).toLowerCase() : "";
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
    if (disabled) return;

    // Palette navigation
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

    // Exact slash command on Enter
    if (key.return) {
      if (SLASH_COMMANDS.some((c) => c.name === buffer)) {
        executeSlashCommand(buffer);
        return;
      }
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

  const borderColor = disabled ? "gray" : "white";
  const displayBuffer = disabled ? buffer : renderBuffer(buffer, cursorPos);

  return (
    <Box flexDirection="column">
      {paletteOpen && filteredCommands.length > 0 && (
        <SlashCommandPalette commands={filteredCommands} selectedIdx={paletteIdx} />
      )}
      <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
        <Text dimColor={disabled}>{disabled ? "  " : "> "}</Text>
        <Text dimColor={disabled}>{displayBuffer}</Text>
        {!disabled && !buffer && (
          <Text dimColor>{"Type a task or /help"}</Text>
        )}
      </Box>
    </Box>
  );
}
