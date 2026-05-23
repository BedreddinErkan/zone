import { randomUUID } from "node:crypto";
import { render } from "ink";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import type { CliFlags } from "../config.js";
import { loadCliConfig, validateCliConfig } from "../config.js";
import { runOneShotInner } from "../dispatch.js";
import { createEventBus } from "../eventBus.js";
import type { LlmPatchProgressUpdate } from "../../core/agentLifecycleEvents.js";

export async function runTui(
  initialPrompt: string | undefined,
  opts: CliFlags
): Promise<void> {
  const config = loadCliConfig(opts);
  try {
    validateCliConfig(config);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
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

  instance = render(
    <ErrorBoundary onCrash={onCrash}>
      <App initialPrompt={initialPrompt} />
    </ErrorBoundary>,
    { exitOnCtrlC: false }
  );

  if (initialPrompt) {
    const bus = createEventBus();
    const runId = randomUUID();

    const onProgress = (update: LlmPatchProgressUpdate): void => {
      if (typeof update === "string") return;
      const evt = update.progress;
      if (evt) bus.emit(evt.type, evt);
    };

    try {
      await runOneShotInner(initialPrompt, config, runId, { externalAc, onProgress });
    } catch {
      // errors surfaced via eventBus in TUI.2; placeholder swallows for now
    } finally {
      instance.unmount();
    }
  } else {
    await instance.waitUntilExit();
  }
}
