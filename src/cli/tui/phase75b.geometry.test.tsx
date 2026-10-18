import React from "react";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Box, render, measureElement, type DOMElement } from "ink";
import chalk from "chalk";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { App } from "./App.js";
import type { StoreAction, StoreState } from "./store.js";
import { role } from "./theme.js";
import { USER_FACING_MODELS } from "../../llm/modelRegistry.js";
import { createEventBus } from "../eventBus.js";
import { UiScheduler } from "./uiScheduler.js";
import { applyResizeRedraw } from "./resize.js";

const cleanups: (() => Promise<void>)[] = [];
const originalColor = chalk.level;
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
  chalk.level = originalColor;
});

/** Real primary-screen, non-debug Ink output. Standard log-update writes each
 * complete dynamic frame in one chunk, prefixed by cursor/erase-line escapes.
 * Keep the raw writes too: frame text alone cannot detect scrollback clearing. */
async function terminal(columns: number, rows: number, props: React.ComponentProps<typeof App> = {}) {
  const chunks: string[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
  stdout.on("data", chunk => chunks.push(String(chunk)));
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  let state!: StoreState;
  let dispatch!: React.Dispatch<StoreAction>;
  const root = React.createRef<DOMElement>();
  const ink = render(<Box ref={root} flexDirection="column"><App {...props} onStateChange={s => { state = s; }} onDispatchCapture={d => { dispatch = d; }} /></Box>, {
    stdout: stdout as unknown as NodeJS.WriteStream, stderr: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, interactive: true, debug: false,
    incrementalRendering: false, patchConsole: false, exitOnCtrlC: false, alternateScreen: false,
  });
  async function settle() {
    for (let i = 0; i < 8; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
      await ink.waitUntilRenderFlush();
    }
  }
  cleanups.push(async () => { ink.unmount(); await ink.waitUntilExit(); ink.cleanup(); });
  await settle();
  return {
    get state() { return state; },
    get raw() { return chunks.join(""); },
    get rawFrame() { return chunks.findLast(c => c.includes("\n")) ?? ""; },
    paintedBoxes(color: string) {
      const found: ReturnType<typeof measureElement>[] = [];
      function visit(node: DOMElement) {
        if (node.style.backgroundColor === color) found.push(measureElement(node));
        for (const child of node.childNodes) if ("childNodes" in child) visit(child);
      }
      if (root.current) visit(root.current);
      return found;
    },
    get frame() { return stripAnsi(chunks.findLast(c => c.includes("\n")) ?? "").trimEnd(); },
    async key(text: string) {
      stdin.write(text);
      if (text === "\x1b") await new Promise(r => setTimeout(r, 80)); // Ink's lone-Esc parser timeout
      await settle();
    },
    async act(action: StoreAction) { dispatch(action); await settle(); },
    async resize(cols: number, height: number) {
      stdout.columns = cols; stdout.rows = height;
      applyResizeRedraw(s => stdout.write(s), () => dispatch({ type: "TRANSCRIPT_REMOUNT" }));
      stdout.emit("resize");
      await settle();
    },
    settle,
  };
}

const sizes = [[120, 40], [100, 24], [80, 24], [60, 24], [40, 24]] as const;
const selectedModel = (frame: string) => frame.split("\n").filter(line => /▸.*\([• ]\)/.test(line));

describe.each([0, 3] as const)("Phase 7.5b real Ink, chalk level %i", level => {
  it.each(sizes)("keeps Composer and palette selection visible at %ix%i", async (cols, rows) => {
    chalk.level = level;
    const t = await terminal(cols, rows);
    expect(t.frame).toContain("▸ ▋"); // harness floor before opening the palette
    await t.key("/");
    expect(t.frame).toContain("▸ /▋");
    expect(t.frame).toMatch(/▸ \/help\s/);
    for (let i = 0; i < 23; i++) await t.key("\x1b[B");
    expect(t.frame).toMatch(/▸ \/feedback\s/);
    expect(t.frame.split("\n").length).toBeLessThanOrEqual(rows);
    expect(t.raw).not.toMatch(/\x1b\[(?:2|3)J/);
    expect(t.raw.includes("38;2;")).toBe(level === 3);
  });

  it.each(sizes)("keeps model navigation visible and bounded at %ix%i", async (cols, rows) => {
    chalk.level = level;
    const t = await terminal(cols, rows, { initialProvidersWithKey: ["anthropic", "openai"] });
    await t.key("/model"); await t.key("\r");
    expect(selectedModel(t.frame)).toHaveLength(1);
    const first = selectedModel(t.frame)[0];
    await t.key("\x1b[B");
    expect(selectedModel(t.frame)).toHaveLength(1);
    expect(selectedModel(t.frame)[0]).not.toBe(first);
    for (let i = 0; i < 16; i++) {
      await t.key("\x1b[B");
      expect(selectedModel(t.frame)).toHaveLength(1);
    }
    expect(t.frame).toContain("Esc");
    expect(t.frame).not.toContain("a coding agent that");
    expect(t.frame.split("\n").length).toBeLessThanOrEqual(rows);
    await t.key("\x1b");
    expect(t.frame).toContain("▸ ▋");
    expect(t.raw).not.toMatch(/\x1b\[(?:2|3)J/);
  });
});

it.each(sizes)("shows one accurate footer per ModelPicker mode and preserves nested Escape at %ix%i", async (cols, rows) => {
  chalk.level = 0;
  const t = await terminal(cols, rows, { gatewayIds: ["gateway-one", "gateway-two"] });
  await t.key("/model"); await t.key("\r");
  expect(t.frame.match(/Enter select/g)).toHaveLength(1);
  expect(t.frame.split("\n").find(l => l.includes("Enter select"))).toMatch(/\bC\b/);
  await t.key("c");
  expect(t.frame).toContain("Enter confirm");
  expect(t.frame).not.toContain("Enter select");
  await t.key("custom-model"); await t.key("\r");
  expect(t.frame).toContain("Enter route");
  expect(t.frame).not.toContain("Enter select");
  expect(t.frame.split("\n").filter(l => /Enter route.*Esc/.test(l))).toHaveLength(1);
  await t.key("\x1b");
  expect(t.state.overlayStack).toEqual(["model"]);
  expect(t.frame).toContain("Enter select");
  await t.key("\x1b");
  expect(t.state.overlayStack).toEqual([]);
  expect(t.frame).toContain("▸ ▋");
});

it.each([40, 60, 80])("keeps whole Composer shortcuts and status actions at %i columns", async cols => {
  chalk.level = 0;
  const model = "a-very-long-provider-qualified-model-name-".repeat(4);
  const t = await terminal(cols, 24, { initialModel: model });
  const lines = t.frame.split("\n");
  const input = lines.findIndex(l => l.includes("▸ ▋"));
  expect(input).toBeGreaterThanOrEqual(0);
  // Composer hints live below the input, not in the decorative hero.
  expect(lines.slice(input + 1).some(l => l.includes("shift+tab") && l.includes("/help"))).toBe(true);
  expect(lines.some(l => /idle/.test(l) && l.includes("/help"))).toBe(true);
  expect(lines.every(l => stringWidth(l) <= cols)).toBe(true);
  expect(t.state.statusBar.model).toBe(model); // truncation is presentation only
});

it("keeps multiline continuation aligned and submits the original edited text", async () => {
  const submit = vi.fn();
  const t = await terminal(80, 24, { onSubmit: submit });
  await t.key("first\\"); await t.key("\r"); await t.key("second");
  const lines = t.frame.split("\n");
  expect(lines.find(l => l.includes("first"))?.indexOf("first"))
    .toBe(lines.find(l => l.includes("second"))?.indexOf("second"));
  expect(t.frame).toContain("second▋");
  await t.key("\r");
  expect(submit).toHaveBeenCalledWith("first\nsecond", expect.any(AbortController), "normal", undefined);
});

it("keeps a tall editor bounded, follows the cursor, and preserves the complete submitted buffer", async () => {
  const submit = vi.fn();
  const t = await terminal(40, 24, { onSubmit: submit });
  for (let i = 0; i < 30; i++) { await t.key(`line-${i}\\`); await t.key("\r"); }
  await t.key("last-line");
  expect(t.frame).toContain("last-line▋");
  expect(t.frame.split("\n").length).toBeLessThanOrEqual(24);
  expect(t.raw).not.toMatch(/\x1b\[(?:2|3)J/);
  // Home changes cursor ownership without changing the buffer.
  await t.key("\x1b[H");
  expect(t.frame).toContain("▋line-0");
  await t.key("\x1b[F");
  expect(t.frame).toContain("last-line▋");
  await t.key("\r");
  expect(submit.mock.calls[0]?.[0]).toBe(Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n") + "\nlast-line");
});

it("paints exactly one teal cell per editable row with an explicit surface foreground", async () => {
  chalk.level = 3;
  const t = await terminal(80, 24);
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(";");
  expect(t.paintedBoxes(role.accent)).toEqual([{ width: 1, height: 1 }]);
  expect(t.rawFrame).toContain(`38;2;${rgb(role.surfaceForeground)}`);
  expect(t.rawFrame).toContain(`48;2;${rgb(role.surface)}`);
  await t.key("first\\"); await t.key("\r"); await t.key("second");
  expect(t.paintedBoxes(role.accent)).toEqual([{ width: 1, height: 2 }]);
  expect(t.paintedBoxes(role.surface)).toEqual([{ width: 79, height: 2 }]);
});

it("separates applied radio from navigation and pairs selected retention text with its background", async () => {
  chalk.level = 3;
  const applied = USER_FACING_MODELS.find(m => m.retention)!;
  const t = await terminal(100, 24, {
    initialProvidersWithKey: ["anthropic", "openai"], initialModel: applied.id,
    initialModelSettings: { version: 2, provider: applied.provider, model: applied.id, updatedAt: "2026-01-01T00:00:00Z" },
  });
  await t.key("/model"); await t.key("\r");
  expect(selectedModel(t.frame)[0]).toContain("(•)");
  const disclosure = t.rawFrame.split("\n").find(l => l.includes("Requires"))!;
  expect(disclosure).toBeDefined();
  const fg = [1, 3, 5].map(i => parseInt(role.selectionForeground.slice(i, i + 2), 16)).join(";");
  expect(disclosure).toContain(`38;2;${fg}`);
  expect(disclosure).not.toContain("\x1b[2m");
  await t.key("\x1b[B");
  expect(selectedModel(t.frame)[0]).toContain("( )");
  expect(t.state.modelSettings?.model).toBe(applied.id);
});

it("keeps retention disclosure readable beside a long selected model id at 40 columns", async () => {
  const applied = USER_FACING_MODELS.find(m => m.retention)!;
  const t = await terminal(40, 24, {
    initialModelSettings: { version: 2, provider: applied.provider, model: applied.id, updatedAt: "2026-01-01T00:00:00Z" },
  });
  await t.key("/model"); await t.key("\r");
  expect(selectedModel(t.frame)).toHaveLength(1);
  expect(t.frame).toContain(`${applied.retention!.minDays}d retention`);
  expect(t.frame).toContain("ZDR");
});

it("keeps effort, spending cap and actions readable in the four-row status at 40 columns", async () => {
  const t = await terminal(40, 24, { initialModel: "a-long-model-label-for-status", initialDailyUsedUsd: 9,
    initialModelSettings: { version: 2, provider: "openai", model: "a-long-model-label-for-status", effort: "high", updatedAt: "2026-01-01T00:00:00Z" },
  });
  const lines = t.frame.split("\n");
  const status = lines.slice(lines.findIndex(l => /^─+$/.test(l.trim())));
  expect(status).toHaveLength(4);
  expect(status[1]).toContain("/help");
  expect(status[1]).toContain("cap 90%");
  expect(status[2]).toContain("high");
  expect(status[2]).toContain("used $9.00");
  expect(status[2]).toContain("cap $10.00");
});

it("keeps the cursor visible when wide and combining characters wrap a long input", async () => {
  const submit = vi.fn();
  const t = await terminal(40, 24, { onSubmit: submit });
  const chunk = "界e\u0301 ".repeat(5);
  for (let i = 0; i < 20; i++) await t.key(chunk);
  expect(t.frame).toContain("▋");
  expect(t.frame.split("\n").length).toBeLessThanOrEqual(24);
  expect(t.raw).not.toMatch(/\x1b\[(?:2|3)J/);
  await t.key("\r");
  expect(submit.mock.calls[0]?.[0]).toBe(chunk.repeat(20).trim());
});

it("reflows an open palette and picker under the existing explicit resize policy", async () => {
  const t = await terminal(120, 40);
  await t.key("/");
  await t.resize(40, 24);
  const afterFirstResize = t.raw.match(/\x1b\[3J/g)?.length ?? 0;
  expect(afterFirstResize).toBeGreaterThanOrEqual(1);
  expect(t.frame).toContain("▸ /▋");
  expect(t.frame).toMatch(/▸ \/help\s/);
  await t.key("\x1b");
  await t.key("/model"); await t.key("\r");
  expect(selectedModel(t.frame)).toHaveLength(1);
  expect(t.raw.match(/\x1b\[3J/g)).toHaveLength(afterFirstResize);
  await t.resize(100, 24);
  expect(selectedModel(t.frame)).toHaveLength(1);
  expect(t.frame).toContain("Enter select");
  const afterSecondResize = t.raw.match(/\x1b\[3J/g)?.length ?? 0;
  expect(afterSecondResize).toBeGreaterThan(afterFirstResize);
  // Ink can also clear when the previous 40-row frame exceeds the resized
  // 24-row viewport. Preserve that existing resize behavior; ordinary
  // transitions after each resize must add no clears of their own.
  await t.key("\x1b");
  expect(t.raw.match(/\x1b\[3J/g)).toHaveLength(afterSecondResize);
});

it.each([40, 80, 120])("keeps preview/overlay transitions in the primary viewport at %i columns", async cols => {
  const bus = createEventBus();
  const scheduler = new UiScheduler(bus);
  cleanups.push(async () => { scheduler.stop(); });
  const t = await terminal(cols, 24, { bus });
  const ac = new AbortController();
  scheduler.beginRun("geometry-run", ac.signal);
  await t.act({ type: "EXECUTION_REGISTERED", runId: "geometry-run" });
  scheduler.enqueue({ type: "agent_loop_start", runId: "geometry-run", flowId: 1, iter: 1, ts: 1, title: "working" });
  scheduler.enqueue({ type: "chat_chunk", runId: "geometry-run", flowId: 1, iter: 1, ts: 2, title: "text", delta: "preview content ".repeat(160) });
  scheduler.flushNow(); await t.settle();
  expect(t.frame).toContain("preview content");
  expect(t.frame).toContain("esc abort");
  scheduler.enqueue({ type: "agent_loop_complete", runId: "geometry-run", flowId: 1, iter: 1, ts: 3, title: "done", detail: "geometry-final-sentinel" });
  scheduler.flushNow(); await t.settle();
  await t.key("/model"); await t.key("\r");
  expect(selectedModel(t.frame)).toHaveLength(1);
  await t.key("\x1b");
  expect(t.frame).toContain("▸ ▋");
  expect(t.raw.split("geometry-final-sentinel").length - 1).toBe(1);
  expect(t.raw).not.toMatch(/\x1b\[(?:2|3)J/);
});
