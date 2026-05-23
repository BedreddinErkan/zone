import { render } from "ink";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import type { CliFlags } from "../config.js";

export async function runTui(
  initialPrompt: string | undefined,
  _opts: CliFlags
): Promise<void> {
  let instance: ReturnType<typeof render> | undefined;

  function onCrash(error: Error): void {
    instance?.unmount();
    throw error;
  }

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

  instance = render(
    <ErrorBoundary onCrash={onCrash}>
      <App initialPrompt={initialPrompt} />
    </ErrorBoundary>,
    { exitOnCtrlC: false }
  );

  await instance.waitUntilExit();
}
