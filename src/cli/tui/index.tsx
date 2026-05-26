import { randomUUID } from "node:crypto";
import { exec, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { render } from "ink";

const execAsync = promisify(exec);
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import type { CliFlags } from "../config.js";
import { loadCliConfig, validateCliConfig } from "../config.js";
import { runOneShotInner, type TuiMode } from "../dispatch.js";
import { createEventBus } from "../eventBus.js";
import { applyStdoutInterception } from "./stdoutShield.js";
import type { LlmPatchProgressUpdate } from "../../core/agentLifecycleEvents.js";
import { loadDiskTrust, diskTrustPrefixes } from "../../api/diskTrust.js";
import { loadDiskKeys } from "../../api/diskKeys.js";
import { saveSession, pruneOldSessions, loadLastSession, type DiskSession } from "../../api/diskSessions.js";
import { loadDiskModel, type DiskModelSettings } from "../../api/diskModel.js";
import type { StoreState } from "./store.js";

const _bannerRequire = createRequire(import.meta.url);
const { version: _zoneVersion } = _bannerRequire("../../../package.json") as { version: string };

function _getGitBranch(): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return ""; }
}

function writeBannerToStdout(opts: { model?: string; capUsd?: number; isResumed: boolean }): void {
  const RESET = "\x1b[0m";
  const CYAN_BOLD = "\x1b[36;1m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const cwd = process.cwd();
  const branch = _getGitBranch();
  const cwdBranch = branch ? `${cwd} · ${branch}` : cwd;
  const model = opts.model || "default";
  const cap = (opts.capUsd ?? 10).toFixed(2);
  const resumed = opts.isResumed ? ` ${DIM}(resumed)${RESET}` : "";
  process.stdout.write(
    `${CYAN_BOLD}[Z]${RESET} ${BOLD}Zone v${_zoneVersion}${RESET}${resumed}\n` +
    `${DIM}${cwdBranch}${RESET}\n` +
    `${BOLD}${model}${RESET} ${DIM}· cap $${cap}${RESET}\n\n`
  );
}

export async function runTui(
  initialPrompt: string | undefined,
  opts: CliFlags
): Promise<void> {
  // Shield must be the very first action — before loadCliConfig can emit anything.
  // Covers SIGINT/SIGTERM paths via process.on("exit") so the original write fn
  // is always restored before the process terminates.
  const restoreStdout = applyStdoutInterception();
  process.on("exit", restoreStdout);

  const storeCapture: { state: StoreState | null } = { state: null };

  const config = loadCliConfig(opts);

  let initialTrustedPrefixes: string[] = [];
  try {
    initialTrustedPrefixes = diskTrustPrefixes(await loadDiskTrust(process.cwd()));
  } catch {
    // non-critical — start with empty trust
  }

  try {
    const diskKeysStore = await loadDiskKeys(process.cwd());
    if (!config.anthropicApiKey) {
      config.anthropicApiKey = diskKeysStore.keys.find(k => k.provider === "anthropic")?.key;
    }
    if (!config.openaiApiKey) {
      config.openaiApiKey = diskKeysStore.keys.find(k => k.provider === "openai")?.key;
    }
  } catch { /* non-critical */ }

  let diskModelSettings: DiskModelSettings | null = null;
  try {
    diskModelSettings = await loadDiskModel(process.cwd());
    if (diskModelSettings) {
      config.model = diskModelSettings.model;
      config.provider = diskModelSettings.provider as typeof config.provider;
      config.effort = diskModelSettings.effort;
    }
  } catch { /* non-critical */ }

  let resumedSession: DiskSession | null = null;
  if (opts.resume) {
    try {
      resumedSession = await loadLastSession(process.cwd());
      if (!resumedSession) {
        process.stderr.write("No prior session found in this directory; starting fresh.\n");
      }
    } catch (err) {
      process.stderr.write(`Resume failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

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

  function buildDiskSession(state: StoreState): DiskSession {
    return {
      version: 1,
      sessionId: state.sessionId,
      startedAt: state.sessionStartedAt,
      lastActivityAt: new Date().toISOString(),
      cwd: process.cwd(),
      model: state.statusBar.model,
      transcript: state.transcript,
      totalCostUsd: state.statusBar.costUsd,
      totalTokens: state.statusBar.cumulativeTokens,
      totalElapsedMs: Date.now() - new Date(state.sessionStartedAt).getTime(),
    };
  }

  // Fallback signal handlers — in TTY raw mode Ctrl+C arrives as \x03 in useInput, not SIGINT.
  // These fire in non-TTY contexts (pipes, test runners that send real signals).
  process.on("SIGINT", () => {
    instance?.unmount();
    const s = storeCapture.state;
    if (s && s.transcript.length > 0) {
      void saveSession(process.cwd(), buildDiskSession(s))
        .then(() => pruneOldSessions(process.cwd()))
        .catch(() => {})
        .finally(() => process.exit(130));
    } else {
      process.exit(130);
    }
  });
  process.on("SIGTERM", () => {
    instance?.unmount();
    const s = storeCapture.state;
    if (s && s.transcript.length > 0) {
      void saveSession(process.cwd(), buildDiskSession(s))
        .then(() => pruneOldSessions(process.cwd()))
        .catch(() => {})
        .finally(() => process.exit(143));
    } else {
      process.exit(143);
    }
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

  const runPrompt = async (prompt: string, ac: AbortController, mode: TuiMode = "normal"): Promise<void> => {
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
      if (evt) {
        bus.emit(evt.type, evt);
      }
    };
    try {
      await runOneShotInner(prompt, config, runId, { externalAc: ac, onProgress, mode });
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

  const onSubmit = (prompt: string, ac: AbortController, mode: TuiMode): void => {
    void runPrompt(prompt, ac, mode);
  };

  writeBannerToStdout({ model: config.model, capUsd: config.dailyUsdCap, isResumed: !!resumedSession });

  instance = render(
    <ErrorBoundary onCrash={onCrash}>
      <App
        initialPrompt={initialPrompt}
        bus={bus}
        initialModel={config.model}
        capUsd={config.dailyUsdCap}
        onSubmit={onSubmit}
        initialTrustedPrefixes={initialTrustedPrefixes}
        resumedSession={resumedSession ?? undefined}
        onStateChange={(s) => { storeCapture.state = s; }}
        initialModelSettings={diskModelSettings}
        onModelApply={(model, provider, effort) => {
          config.model = model;
          config.provider = provider as typeof config.provider;
          config.effort = effort;
        }}
      />
    </ErrorBoundary>,
    { exitOnCtrlC: false, alternateScreen: false }
  );

  // Single path: wait for explicit exit (Ctrl+C → \x03 in useInput → useApp.exit())
  await instance.waitUntilExit();

  const finalState = storeCapture.state;
  if (finalState && finalState.transcript.length > 0) {
    try {
      await saveSession(process.cwd(), buildDiskSession(finalState));
      await pruneOldSessions(process.cwd());
    } catch { /* non-critical */ }
  }

  restoreStdout();
}
