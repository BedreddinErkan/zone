import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "ink";
import { StoreProvider, useStore, type BootData, type StoreAction, type StoreState, type TranscriptEntry } from "./store.js";
import { Transcript } from "./components/Transcript.js";
import { App } from "./App.js";
import { createEventBus } from "../eventBus.js";
import { UiScheduler } from "./uiScheduler.js";
import type { DiskSession } from "../../api/diskSessions.js";
import type { ZoneStructuredProgressEvent } from "../../core/agentLifecycleEvents.js";
import { PRINT_BATCH_SIZE } from "./transcriptDelivery.js";
import { applyResizeRedraw } from "./resize.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const entry = (text: string): TranscriptEntry => ({ kind: "assistant_final", text });
const session = (transcript: TranscriptEntry[]): DiskSession => ({
  version: 1, sessionId: "printing-test", startedAt: "2026-01-01T00:00:00Z",
  lastActivityAt: "2026-01-01T00:00:00Z", cwd: "/synthetic", model: "test",
  transcript, totalCostUsd: 0, totalTokens: 0, totalElapsedMs: 0,
});

/** Non-debug Ink writes: debug frames replay Static history and cannot prove exactly-once output. */
async function terminal(seed: TranscriptEntry[] = [], fullApp = false,
  initial: { boot?: BootData; threads?: DiskSession["subagentThreads"] } = {}) {
  let state!: StoreState;
  let dispatch!: React.Dispatch<StoreAction>;
  let maxPending = 0;
  let maxActive = 0;
  const capture = (s: StoreState) => {
    state = s;
    maxPending = Math.max(maxPending, s.printDelivery.pending.length);
    const a = s.printDelivery.active;
    maxActive = Math.max(maxActive, a ? a.through - a.from + 1 : 0);
  };
  const chunks: string[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 });
  stdout.on("data", chunk => chunks.push(String(chunk)));
  let paused = false;
  const callbacks: (() => void)[] = [];
  const write = stdout.write.bind(stdout);
  stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    // Delay the real stream's empty-write completion, the fence used by Ink's
    // public flush API. Ordinary Static bytes still go through the real stream.
    if (chunk === "" && typeof args[0] === "function") {
      const callback = args[0] as () => void;
      return write("", () => { if (paused) callbacks.push(callback); else callback(); });
    }
    return (write as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as typeof stdout.write;
  const release = () => { paused = false; callbacks.splice(0).forEach(callback => callback()); };
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const bus = createEventBus();
  const scheduler = new UiScheduler(bus);
  function Capture({ version }: { version: number }) {
    const store = useStore(); capture(store.state); dispatch = store.dispatch;
    return <Transcript key={version} />;
  }
  const tree = (version = 0) => fullApp
    ? <App bus={bus} initialBoot={initial.boot} resumedSession={{ ...session(seed), subagentThreads: initial.threads }} onDispatchCapture={d => { dispatch = d; }} onStateChange={capture} />
    : <StoreProvider initialValues={{ model: "test", capUsd: 10, resumedTranscript: seed,
      initialBoot: initial.boot, resumedSubagentThreads: initial.threads }}><Capture version={version} /></StoreProvider>;
  const ink = render(tree(), { stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, stderr: stdout as unknown as NodeJS.WriteStream,
    interactive: true, debug: false, exitOnCtrlC: false, patchConsole: false, alternateScreen: false });
  async function settle() {
    // Bounded drain of React effects and Ink's actual stream flush, not a wall-clock sleep.
    for (let i = 0; i < 64; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await ink.waitUntilRenderFlush();
    }
  }
  cleanups.push(async () => { release(); scheduler.stop(); ink.unmount(); await ink.waitUntilExit(); ink.cleanup(); });
  await settle();
  return {
    get state() { return state; }, get output() { return chunks.join(""); },
    get maxPending() { return maxPending; }, get maxActive() { return maxActive; },
    pauseFlush() { paused = true; }, release,
    async pump() { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); },
    count(text: string) { return chunks.join("").split(text).length - 1; },
    dispatch(action: StoreAction) { dispatch(action); }, settle,
    async act(...actions: StoreAction[]) { actions.forEach(dispatch); await settle(); },
    async remount() { ink.rerender(tree(1)); await settle(); },
    async redraw() { applyResizeRedraw(s => stdout.write(s), () => dispatch({ type: "TRANSCRIPT_REMOUNT" })); await settle(); },
    begin(runId = "A") { const ac = new AbortController(); scheduler.beginRun(runId, ac.signal); dispatch({ type: "EXECUTION_REGISTERED", runId }); return ac; },
    async send(type: ZoneStructuredProgressEvent["type"], extra: Partial<ZoneStructuredProgressEvent> & { summary?: string } = {}) {
      scheduler.enqueue({ type, runId: "A", flowId: 1, iter: 1, ts: 1, title: type, ...extra });
      scheduler.flushNow(); await settle();
    },
  };
}

describe("committed transcript → real Ink terminal output", () => {
  it("prints entry 401 and subsequent entries exactly once across compaction", async () => {
    const t = await terminal(Array.from({ length: 399 }, (_, i) => entry(`seed-${i}-end`)));
    await t.act({ type: "ASSISTANT_FINAL", text: "before-cap-end" });
    expect(t.count("before-cap-end")).toBe(1);
    await t.act({ type: "ASSISTANT_FINAL", text: "trigger-cap-end" });
    expect(t.state.transcript).toHaveLength(101);
    expect(t.count("trigger-cap-end")).toBe(1);
    await t.act({ type: "ASSISTANT_FINAL", text: "after-cap-end" });
    expect(t.count("after-cap-end")).toBe(1);
    expect(t.count("seed-398-end")).toBe(1);
  });

  it("prints every entry in a React batch crossing compaction", async () => {
    const t = await terminal(Array.from({ length: 400 }, (_, i) => entry(`seed-${i}-end`)));
    await t.act(...Array.from({ length: 5 }, (_, i): StoreAction => ({ type: "ASSISTANT_FINAL", text: `batched-${i}-end` })));
    for (let i = 0; i < 5; i++) expect(t.count(`batched-${i}-end`)).toBe(1);
  });

  it("prints a 513-entry burst even when compaction precedes the first paint", async () => {
    const t = await terminal();
    await t.act(...Array.from({ length: 513 }, (_, i): StoreAction => ({ type: "ASSISTANT_FINAL", text: `burst-${i}-end` })));
    expect(t.output.match(/burst-\d+-end/g)).toEqual(Array.from({ length: 513 }, (_, i) => `burst-${i}-end`));
    expect(t.state.transcript.length).toBeLessThanOrEqual(400);
  });

  it("prints sequential child results before exactly one completion footer", async () => {
    const t = await terminal();
    await t.act({ type: "SUBAGENT_STARTED", subagentId: "child", subagentType: "worker", title: "child-title-end" });
    for (const text of ["child-one-end", "child-two-end"]) await t.act(
      { type: "TOOL_CALL_OPEN", toolName: "write_file", args: text },
      { type: "TOOL_RESULT_PUSH", ok: true, detail: "ok" }, { type: "TOOL_CALL_CLOSE" });
    await t.act({ type: "SUBAGENT_COMPLETED", subagentId: "child", status: "completed", summary: "child-finished-end" });
    expect(t.count("child-one-end")).toBe(1); expect(t.count("child-two-end")).toBe(1);
    expect(t.count("└─")).toBe(1); expect(t.count("child-finished-end")).toBe(1);
    expect(t.output.indexOf("child-two-end")).toBeLessThan(t.output.indexOf("child-finished-end"));
  });

  it("prints only the newly committed fragment when logical narration merges", async () => {
    const t = await terminal();
    for (const text of ["narration-one-end", "narration-two-end"]) await t.act(
      { type: "TRANSCRIPT_APPEND_NARRATION", text }, { type: "NARRATION_COMMIT" });
    expect(t.state.transcript).toHaveLength(1);
    expect(t.count("narration-one-end")).toBe(1); expect(t.count("narration-two-end")).toBe(1);
  });

  it("does not replay retained history on incidental Transcript remount", async () => {
    const t = await terminal([entry("remount-sentinel-end")]);
    await t.remount();
    expect(t.count("remount-sentinel-end")).toBe(1);
  });

  it("keeps preview transient and avoids overflow clears during finalization at compaction", async () => {
    const t = await terminal(Array.from({ length: 400 }, (_, i) => entry(`app-seed-${i}-end`)), true);
    t.begin(); await t.send("agent_loop_start");
    await t.send("chat_chunk", { delta: "preview-only-end" });
    await t.send("agent_loop_complete", { detail: "authoritative-final-end" });
    expect(t.state.liveTail.streamingAnswer).toBe("");
    expect(t.state.transcript.some(e => "text" in e && e.text === "preview-only-end")).toBe(false);
    expect(t.output.includes("\x1b[3J")).toBe(false);
    expect(t.count("authoritative-final-end")).toBe(1);
    expect(t.count("app-seed-399-end")).toBe(1);
  });

  it("waits for stdout flush, bounds active batches, and releases the complete backlog", async () => {
    const t = await terminal();
    t.pauseFlush();
    for (let i = 0; i < 513; i++) t.dispatch({ type: "ASSISTANT_FINAL", text: `slow-${i}-end` });
    await t.pump();
    expect(t.state.printDelivery.active?.submitted).toBe(true);
    expect(t.state.printDelivery.acknowledged).toBe(0);
    expect(t.state.printDelivery.pending).toHaveLength(513);
    expect(t.output.match(/slow-\d+-end/g)).toHaveLength(PRINT_BATCH_SIZE);
    const output = t.output;
    await t.pump();
    expect(t.output).toBe(output); // Stalled output neither advances nor replays.
    const remounted = t.remount();
    await t.pump();
    expect(t.output.match(/slow-\d+-end/g)).toHaveLength(PRINT_BATCH_SIZE);
    t.release(); await remounted;
    expect(t.output.match(/slow-\d+-end/g)).toEqual(Array.from({ length: 513 }, (_, i) => `slow-${i}-end`));
    expect(t.maxActive).toBe(64); expect(t.maxPending).toBe(513);
    expect(t.state.printDelivery.pending).toHaveLength(0);
    expect(t.state.printDelivery.active).toBeNull();
    expect(t.state.printDelivery.acknowledged).toBe(513);
  });

  it("rejects premature, out-of-range, repeated and stale-presentation acknowledgements", async () => {
    const t = await terminal();
    t.pauseFlush();
    t.dispatch({ type: "ASSISTANT_FINAL", text: "old-epoch-end" });
    const epoch = t.state.printDelivery.epoch;
    t.dispatch({ type: "PRINT_BATCH_ACK", epoch, through: 1 }); // No submitted batch yet.
    await t.pump();
    expect(t.state.printDelivery.pending).toHaveLength(1);
    t.dispatch({ type: "PRINT_BATCH_ACK", epoch, through: 999 }); await t.pump();
    expect(t.state.printDelivery.pending).toHaveLength(1);
    t.dispatch({ type: "SESSION_RESUME", session: session([entry("new-epoch-end")]) });
    await t.pump();
    t.dispatch({ type: "PRINT_BATCH_ACK", epoch, through: 1 }); await t.pump();
    expect(t.state.printDelivery.pending).toHaveLength(1);
    expect(t.state.printDelivery.acknowledged).toBe(0);
    t.release(); await t.settle();
    expect(t.count("old-epoch-end")).toBe(1); expect(t.count("new-epoch-end")).toBe(1);
    const settled = t.state;
    await t.act({ type: "PRINT_BATCH_ACK", epoch: settled.printDelivery.epoch, through: 1 });
    expect(t.state).toBe(settled);
  });

  it("prints restored old-format history once per explicit restore, not per rerender", async () => {
    const t = await terminal([entry("startup-restored-end")]);
    const restored = session([entry("explicit-restored-end")]);
    await t.act({ type: "SESSION_RESUME", session: restored });
    await t.act({ type: "STATUS_UPDATE", iter: 9 });
    await t.act({ type: "ASSISTANT_FINAL", text: "after-restore-end" });
    expect(t.count("startup-restored-end")).toBe(1);
    expect(t.count("explicit-restored-end")).toBe(1); expect(t.count("after-restore-end")).toBe(1);
    await t.act({ type: "SESSION_RESUME", session: restored });
    expect(t.count("explicit-restored-end")).toBe(2);
    await t.act({ type: "TRANSCRIPT_CLEAR" }, { type: "ASSISTANT_FINAL", text: "after-clear-end" });
    expect(t.count("after-clear-end")).toBe(1);
  });

  it("keeps the explicit clear-and-redraw resize policy", async () => {
    const t = await terminal([entry("resize-history-end")]);
    await t.redraw();
    expect(t.count("\x1b[3J")).toBe(1);
    expect(t.count("resize-history-end")).toBe(2); // Intentional redraw after clearing, not ordinary delivery.
    expect(t.output.indexOf("\x1b[3J")).toBeLessThan(t.output.lastIndexOf("resize-history-end"));
  });

  it("preserves execution isolation, cancellation, and distinct subsequent flows", async () => {
    const t = await terminal([], true);
    const ac = t.begin(); await t.send("agent_loop_start");
    await t.send("chat_chunk", { delta: "cancel-preview-end" });
    ac.abort(); await t.act({ type: "RUN_ABORTED" });
    await t.send("agent_loop_complete", { detail: "cancelled-final-end" });
    t.begin("B"); await t.send("agent_loop_start", { runId: "B" });
    await t.send("chat_chunk", { runId: "B", delta: "new-preview-end" });
    await t.send("agent_loop_complete", { detail: "late-old-final-end" });
    await t.send("agent_loop_complete", { runId: "B", detail: "new-final-end" });
    await t.send("agent_loop_complete", { runId: "B", detail: "new-final-end" });
    await t.send("agent_loop_start", { runId: "B", flowId: 2 });
    await t.send("agent_loop_complete", { runId: "B", flowId: 2, detail: "second-flow-end" });
    expect(t.count("cancelled-final-end")).toBe(0); expect(t.count("late-old-final-end")).toBe(0);
    expect(t.count("new-final-end")).toBe(1); expect(t.count("second-flow-end")).toBe(1);
    expect(t.state.liveTail.streamingAnswer).toBe("");
    expect(t.state.printDelivery.pending).toHaveLength(0);
    expect(t.output.includes("\x1b[3J")).toBe(false);
  });

  it("clips tall previews within the viewport without replaying committed history", async () => {
    const t = await terminal([entry("tall-preview-history-end")], true);
    t.begin(); await t.send("agent_loop_start");
    await t.send("chat_chunk", { delta: Array.from({ length: 70 }, (_, i) => `preview line ${i}`).join("\n") });
    await t.send("agent_loop_complete", { detail: "tall-preview-final-end" });
    expect(t.output.includes("\x1b[3J")).toBe(false);
    expect(t.count("tall-preview-history-end")).toBe(1); expect(t.count("tall-preview-final-end")).toBe(1);
  });

  it("prints child reads, completion and parent narration in scheduler order", async () => {
    const t = await terminal([], true);
    t.begin(); await t.send("agent_loop_start");
    await t.send("subagent_started", { subagentId: "child", subagentType: "worker", title: "pipeline-child-end" });
    for (const path of ["pipeline-one-end", "pipeline-two-end"]) {
      await t.send("tool_call", { toolName: "read_file", detail: path });
      await t.send("tool_result", { status: "success", detail: "read" });
    }
    await t.send("subagent_completed", { subagentId: "child", status: "success", summary: "pipeline-child-done-end" });
    await t.send("narration", { text: "pipeline-narration-end" });
    await t.send("agent_loop_complete", { detail: "pipeline-parent-end" });
    expect(t.count("pipeline-child-done-end")).toBe(1);
    expect(t.count("└─")).toBe(1);
    expect(t.state.transcript.find(e => e.kind === "tool_call_group")).toMatchObject({ subagentId: "child" });
    expect(t.output.indexOf("pipeline-two-end")).toBeGreaterThan(-1);
    expect(t.output.lastIndexOf("pipeline-two-end")).toBeLessThan(t.output.indexOf("└─"));
    expect(t.output.indexOf("└─")).toBeLessThan(t.output.indexOf("pipeline-parent-end"));
  });

  it("releases delivered records over repeated compactions without a printed-history ledger", async () => {
    const t = await terminal();
    for (let round = 0; round < 3; round++) {
      await t.act(...Array.from({ length: 513 }, (_, i): StoreAction => ({ type: "ASSISTANT_FINAL", text: `long-${round}-${i}-end` })));
      expect(t.state.transcript.length).toBeLessThanOrEqual(400);
      expect(t.state.printDelivery.pending).toHaveLength(0);
      expect(t.state.printDelivery.active).toBeNull();
      expect(t.state.printDelivery.acknowledged).toBe((round + 1) * 513);
    }
    const printed = t.output.match(/long-\d+-\d+-end/g) ?? [];
    expect(printed).toHaveLength(1539); expect(new Set(printed).size).toBe(1539);
    expect(t.maxPending).toBe(513); expect(t.maxActive).toBe(64);
  });

  it("snapshots restored payloads and preserves records appended behind an in-flight batch", async () => {
    const t = await terminal();
    t.pauseFlush();
    const restored = session(Array.from({ length: 70 }, (_, i) => entry(`immutable-${i}-end`)));
    t.dispatch({ type: "SESSION_RESUME", session: restored }); await t.pump();
    // This entry is queued but has not yet reached Ink. Mutating the caller's
    // loaded object must not alter the immutable record already captured.
    (restored.transcript[65] as { text: string }).text = "mutated-payload-end";
    t.dispatch({ type: "ASSISTANT_FINAL", text: "behind-flight-end" }); await t.pump();
    expect(t.state.printDelivery.pending).toHaveLength(71);
    t.release(); await t.settle();
    expect(t.count("immutable-65-end")).toBe(1); expect(t.count("mutated-payload-end")).toBe(0);
    expect(t.count("behind-flight-end")).toBe(1);
    expect(t.output.indexOf("immutable-69-end")).toBeLessThan(t.output.indexOf("behind-flight-end"));
  });

  it("restores child attribution and footer metadata without a disk format migration", async () => {
    const t = await terminal();
    const restored = session([{ kind: "tool_call", toolName: "write_file", args: "restored-child-file-end",
      results: [{ ok: true, detail: "ok" }], subagentId: "restored-child" }]);
    restored.subagentThreads = { "restored-child": { subagentId: "restored-child", subagentType: "explore",
      title: "restored-child-title-end", status: "completed", toolCallCount: 1, summary: "restored-child-summary-end" } };
    await t.act({ type: "SESSION_RESUME", session: restored });
    expect(t.count("restored-child-file-end")).toBe(1);
    expect(t.count("restored-child-title-end")).toBe(1);
    expect(t.count("restored-child-summary-end")).toBe(1);
    await t.remount(); expect(t.count("restored-child-summary-end")).toBe(1);
  });

  it("does not print late final content after failure", async () => {
    const t = await terminal([], true);
    t.begin(); await t.send("agent_loop_start");
    await t.send("chat_chunk", { delta: "failed-preview-end" });
    await t.send("run_failed", { title: "failure-marker-end" });
    await t.send("agent_loop_complete", { detail: "after-failure-end" });
    expect(t.state.liveTail.streamingAnswer).toBe("");
    expect(t.count("after-failure-end")).toBe(0);
    expect(t.state.printDelivery.pending).toHaveLength(0);
  });

  it("prints the welcome record once and hydrates restored child metadata at App startup", async () => {
    const boot = { version: "test", user: "welcome-user-end", repoPath: "/synthetic", branch: "test" };
    const t = await terminal([{ kind: "tool_call", toolName: "write_file", args: "startup-child-file-end",
      results: [{ ok: true, detail: "ok" }], subagentId: "startup-child" }], true, {
      boot, threads: { "startup-child": { subagentId: "startup-child", subagentType: "worker",
        title: "startup-child-title-end", status: "completed", toolCallCount: 1, summary: "startup-child-summary-end" } },
    });
    await t.act({ type: "STATUS_UPDATE", iter: 2 });
    expect(t.count("welcome-user-end")).toBe(1);
    expect(t.count("startup-child-summary-end")).toBe(1);
    expect(t.state.printDelivery.pending).toHaveLength(0);
  });
});
