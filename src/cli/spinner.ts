const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL_MS = 80;

export interface Spinner {
  start(text: string): void;
  update(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
  pauseForPrompt(): void;
  resumeAfterPrompt(): void;
}

export function createSpinner(isTTY: boolean, noColor: boolean): Spinner {
  let frame = 0;
  let currentText = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;

  const green = noColor ? "" : "\x1b[32m";
  const red = noColor ? "" : "\x1b[31m";
  const cyan = noColor ? "" : "\x1b[36m";
  const reset = noColor ? "" : "\x1b[0m";

  function render(): void {
    if (!isTTY || paused) return;
    const symbol = `${cyan}${FRAMES[frame % FRAMES.length]}${reset}`;
    process.stderr.write(`\r${symbol} ${currentText}  `);
    frame++;
  }

  function clear(): void {
    if (!isTTY) return;
    process.stderr.write("\r\x1b[K");
  }

  function stopTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start(text: string): void {
      currentText = text;
      frame = 0;
      if (isTTY && !timer) {
        timer = setInterval(render, FRAME_INTERVAL_MS);
      } else if (!isTTY) {
        process.stderr.write(`${text}\n`);
      }
    },

    update(text: string): void {
      currentText = text;
      if (!isTTY) {
        process.stderr.write(`${text}\n`);
      }
    },

    succeed(text: string): void {
      stopTimer();
      clear();
      process.stdout.write(`${green}✓${reset} ${text}\n`);
    },

    fail(text: string): void {
      stopTimer();
      clear();
      process.stdout.write(`${red}✗${reset} ${text}\n`);
    },

    stop(): void {
      stopTimer();
      clear();
    },

    pauseForPrompt(): void {
      paused = true;
      clear();
    },

    resumeAfterPrompt(): void {
      paused = false;
      if (isTTY && !timer && currentText) {
        timer = setInterval(render, FRAME_INTERVAL_MS);
      }
    },
  };
}
