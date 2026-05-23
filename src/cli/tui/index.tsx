import { randomUUID } from "node:crypto";
import { render } from "ink";
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
  const externalAc = new AbortController();

  function onCrash(error: Error): void {
    instance?.unmount();
    throw error;
  }

  process.on("SIGINT", () => {
    externalAc.abort();
    instance?.unmount();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    externalAc.abort();
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

  instance = render(
    <ErrorBoundary onCrash={onCrash}>
      <App
        initialPrompt={initialPrompt}
        bus={bus}
        initialModel={config.model}
        capUsd={config.dailyUsdCap}
        externalAc={externalAc}
      />
    </ErrorBoundary>,
    { exitOnCtrlC: false, alternateScreen: true }
  );

  if (initialPrompt) {
    const runId = randomUUID();

    const onProgress = (update: LlmPatchProgressUpdate): void => {
      if (typeof update === "string") return;
      const evt = update.progress;
      if (evt) bus.emit(evt.type, evt);
    };

    try {
      await runOneShotInner(initialPrompt, config, runId, { externalAc, onProgress });
    } catch {
      // errors surfaced via eventBus; placeholder swallows for now
    } finally {
      // Hold briefly so user can see the final done/aborted state before alt-screen clears
      await new Promise<void>((resolve) => setTimeout(resolve, 1500));
      instance.unmount();
      restoreStdout();
    }
  } else {
    await instance.waitUntilExit();
    restoreStdout();
  }
}
