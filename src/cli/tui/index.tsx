import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { render } from "ink";

const execAsync = promisify(exec);
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import type { CliFlags } from "../config.js";
import { loadCliConfig, validateCliConfig } from "../config.js";
import { runOneShotInner } from "../dispatch.js";
import { createEventBus } from "../eventBus.js";
import { applyStdoutInterception } from "./stdoutShield.js";
import type { LlmPatchProgressUpdate } from "../../core/agentLifecycleEvents.js";

export async function runTui(
  initialPrompt: string | undefined,
  opts: CliFlags
): Promise<void> {
  // Shield must be the very first action — before loadCliConfig can emit anything.
  // Covers SIGINT/SIGTERM paths via process.on("exit") so the original write fn
  // is always restored before the process terminates.
  const restoreStdout = applyStdoutInterception();
  process.on("exit", restoreStdout);

  const config = loadCliConfig(opts);

  // Validate API key only when we're about to make API calls.
  // In no-args (idle) mode the TUI renders without a pending task — defer validation.
  if (initialPrompt !== undefined) {
    try {
      validateCliConfig(config);
    } catch (err) {
      restoreStdout();
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  }

  let instance: ReturnType<typeof render> | undefined;

  function onCrash(error: Error): void {
    instance?.unmount();
    throw error;
  }

  // Fallback signal handlers — in TTY raw mode Ctrl+C arrives as \x03 in useInput, not SIGINT.
  // These fire in non-TTY contexts (pipes, test runners that send real signals).
  process.on("SIGINT", () => {
    instance?.unmount();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    instance?.unmount();
    process.exit(143);
  });
  process.on("uncaughtException", (err) => {
    instance?.unmount();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    instance?.unmount();
    console.error(err);
    process.exit(1);
  });

  const bus = createEventBus();

  const runPrompt = async (prompt: string, ac: AbortController): Promise<void> => {
    const runId = randomUUID();

    // ! shell escape — run cmd directly without LLM; results appear as a tool entry
    if (prompt.startsWith("!")) {
      const cmd = prompt.slice(1).trim();
      if (!cmd) return;
      const ts = Date.now();
      bus.emit("tool_call", { runId, ts, type: "tool_call", title: `[tool] shell: ${cmd}` });
      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: process.cwd(), timeout: 30_000 });
        const out = [stdout, stderr].filter(Boolean).join("\n").trim() || "(no output)";
        bus.emit("tool_result", { runId, ts: Date.now(), type: "tool_result",
          toolName: "shell", title: out.slice(0, 100), detail: out, status: "success" });
      } catch (err: unknown) {
        const out = err instanceof Error ? err.message : String(err);
        bus.emit("tool_result", { runId, ts: Date.now(), type: "tool_result",
          toolName: "shell", title: out.slice(0, 100), detail: out, status: "error" });
      }
      return;
    }

    const onProgress = (update: LlmPatchProgressUpdate): void => {
      if (typeof update === "string") return;
      const evt = update.progress;
      if (evt) bus.emit(evt.type, evt);
    };
    try {
      await runOneShotInner(prompt, config, runId, { externalAc: ac, onProgress });
    } catch {
      // errors surfaced via eventBus progress events
    } finally {
      // Safety net: if runLlmPatchFlow threw before emitting agent_loop_complete,
      // runState would stay "running" forever. Aborted runs are handled by
      // App.tsx Esc handler (RUN_ABORTED dispatch) — skip those.
      if (!ac.signal.aborted) {
        bus.emit("agent_loop_complete", {
          runId,
          ts: Date.now(),
          type: "agent_loop_complete",
          title: "Run ended",
        });
      }
    }
  };

  const onSubmit = (prompt: string, ac: AbortController): void => {
    void runPrompt(prompt, ac);
  };

  instance = render(
    <ErrorBoundary onCrash={onCrash}>
      <App
        initialPrompt={initialPrompt}
        bus={bus}
        initialModel={config.model}
        capUsd={config.dailyUsdCap}
        onSubmit={onSubmit}
      />
    </ErrorBoundary>,
    { exitOnCtrlC: false, alternateScreen: true }
  );

  // Single path: wait for explicit exit (Ctrl+C → \x03 in useInput → useApp.exit())
  await instance.waitUntilExit();
  restoreStdout();
}
