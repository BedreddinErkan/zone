/**
 * Phase F1 — UI tool-input typewriter tests.
 *
 * Tests that tool_input_delta SSE events produce the correct DOM:
 *  1. start (isFirstDelta=true) → .tool-stream-block created in logBlock
 *  2. delta events → pre content grows
 *  3. header label updates once filePath becomes available
 *  4. tool_result (success) → .ts-settled class added, label becomes "✓ Patched"
 *  5. tool_result (error) → .ts-failed class added, label becomes "✗ Write failed"
 *  6. non-write tool_result → does NOT affect tool-stream blocks
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// ── minimal harness (reuses the same MockElement / MockClassList as index.test.ts) ──

class MockClassList {
  private classes = new Set<string>();
  constructor(initial = "") { for (const c of initial.split(/\s+/).filter(Boolean)) this.classes.add(c); }
  add(...names: string[]) { for (const n of names) this.classes.add(n); }
  remove(...names: string[]) { for (const n of names) this.classes.delete(n); }
  contains(name: string) { return this.classes.has(name); }
  toggle(name: string, force?: boolean) {
    if (force === true) { this.classes.add(name); return true; }
    if (force === false) { this.classes.delete(name); return false; }
    if (this.classes.has(name)) { this.classes.delete(name); return false; }
    this.classes.add(name); return true;
  }
  toString() { return [...this.classes].join(" "); }
  setFromString(v: string) { this.classes = new Set(v.split(/\s+/).filter(Boolean)); }
}

class MockElement {
  id: string;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  private classListValue: MockClassList;
  private textContentValue = "";
  private innerHtmlValue = "";

  constructor(id: string, className = "") {
    this.id = id;
    this.classListValue = new MockClassList(className);
  }

  get classList() { return this.classListValue; }
  get className() { return this.classListValue.toString(); }
  set className(v: string) { this.classListValue.setFromString(v); }
  get textContent() { return this.textContentValue; }
  set textContent(v: string) { this.textContentValue = String(v ?? ""); }
  get innerHTML() { return this.innerHtmlValue; }
  set innerHTML(v: string) {
    this.innerHtmlValue = String(v ?? "");
    this.textContentValue = v.replace(/<[^>]*>/g, "");
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  querySelector(sel?: string): MockElement {
    const found = this.querySelectorAll(sel ?? "")[0];
    if (found) return found;
    const child = new MockElement(`${this.id}-q`);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  querySelectorAll(sel: string): MockElement[] {
    const cm = sel.match(/^\.([A-Za-z0-9_-]+)$/);
    if (!cm) return [];
    const results: MockElement[] = [];
    const visit = (n: MockElement) => {
      for (const c of n.children) { if (c.classList.contains(cm[1]!)) results.push(c); visit(c); }
    };
    visit(this);
    return results;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
    this.parentElement = null;
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute(name: string, value: string) { if (name === "class") this.className = value; }
  getAttribute(name: string) { return this.dataset[name] ?? null; }
  click() {}
  scrollIntoView() {}
  focus() {}
}

const _rawHtml = readFileSync(path.resolve("src/ui/index.html"), "utf8");
const appScript = [..._rawHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map((m) => m[1]?.trim() ?? "")
  .filter(Boolean)
  .join("\n\n");

function buildHarness() {
  const elements = new Map<string, MockElement>();
  const ensureEl = (id: string, cls = ""): MockElement => {
    if (!elements.has(id)) { const el = new MockElement(id, cls); elements.set(id, el); }
    return elements.get(id)!;
  };
  // Pre-create elements the script needs at boot.
  for (const id of [
    "chatPanel", "logPanel", "runGroup", "threadList", "leftPanel",
    "taskInput", "task", "repoPath", "runModeSelect",
    "execBtn", "execText", "spinner", "applyBtn", "applyText",
    "progressBox", "progressText", "successBox", "errorBox",
    "diffSection", "fileList", "patchSummary",
    "billingSummaryBox", "billingSummaryLabel", "billingSummaryMeta",
    "recentRunsSection", "recentRunsEmpty", "recentRunsList",
    "decisionSection", "patchSection", "resultSummaryBox",
    "resultSummaryTitle", "resultSummarySubtitle", "resultSummaryChips",
    "warningsList", "contextFilesBox", "contextFilesList",
    "folderPickerBtn", "repoSelectionBox", "complexityBadge", "frameworkBadge",
    "decisionBadge", "bdot", "badgeText", "confVal", "riskVal", "filesVal",
    "rDestructive", "rDestructiveVal", "rSchema", "rSchemaVal", "rMass", "rMassVal",
    "applyStatusBox", "applySpinner", "restoreBtn", "restoreSpinner", "restoreText",
    "dryRunBtn", "drySpinner", "dryRunText", "diffSummaryBox", "diffFileList",
    "folderPickerFallback", "repoSelectionLabel", "repoSelectionMeta",
  ]) ensureEl(id);

  const document = {
    body: ensureEl("body"),
    addEventListener() {},
    removeEventListener() {},
    createElement(tag: string) { return new MockElement(tag); },
    createTextNode(text: string) { const n = new MockElement("text"); n.textContent = text; return n; },
    getElementById(id: string) { return ensureEl(id); },
    querySelector() { return ensureEl("query"); },
    querySelectorAll() { return []; },
  };

  const ctx: Record<string, unknown> = {
    document,
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { clipboard: { writeText: async () => {} } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    EventSource: class { constructor() {} onmessage = null; close() {} },
    window: {
      location: { href: "" },
      parent: { postMessage() {} },
      top: null,
      currentUser: { id: "user_test" },
      addEventListener() {},
      removeEventListener() {},
    },
    Math,
    Date,
    performance: { now: () => Date.now(), memory: undefined },
    encodeURIComponent,
    CSS: { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_") },
  };
  // Merge window into ctx so `window.X` and bare `X` both work.
  Object.assign(ctx, ctx.window);

  vm.runInNewContext(appScript, ctx);
  return { ctx, elements, ensureEl };
}

// ── tests ──────────────────────────────────────────────────────────────────────

const RUN_ID = "run-f1-ui-1";

function sendDelta(
  ctx: Record<string, unknown>,
  blockId: string,
  delta: string,
  isFirstDelta: boolean,
  title = "",
  toolName = "apply_patch"
) {
  (ctx as { handleSSEPayload: (payload: unknown, runId: string) => void }).handleSSEPayload(
    {
      stage: "agent_loop",
      progress: {
        type: "tool_input_delta",
        blockId,
        delta,
        isFirstDelta,
        title,
        toolName,
      },
    },
    RUN_ID
  );
}

describe("Phase F1 — UI tool_input_delta rendering", () => {
  it("start event creates .tool-stream-block inside logBlock", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-1", '{"filePath":', true, "✎ Writing files.ts...");

    const blocks = logBlock.querySelectorAll(".tool-stream-block");
    expect(blocks.length).toBe(1);
  });

  it("start event sets block id and toolName on dataset", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-data-1", '{"filePath":', true, "✎ Writing...", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    expect(block.dataset.blockId).toBe("blk-data-1");
    expect(block.dataset.toolName).toBe("apply_patch");
  });

  it("delta events append decoded patch content to the pre element", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-grow", '{"filePath":"src/a.ts"', true, "✎ Writing a.ts...");
    sendDelta(ctx, "blk-grow", ',"patch":"--- FIND ---', false, "✎ Writing a.ts...");
    sendDelta(ctx, "blk-grow", '\nfoo\n--- REPLACE ---\nbar"}', false, "✎ Writing a.ts...");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    expect(pre!.textContent!.length).toBeGreaterThan(0);
    // F1.1: pre shows decoded patch content, not raw JSON
    expect(pre!.textContent).toContain("--- FIND ---");
    expect(pre!.textContent).toContain("--- REPLACE ---");
  });

  it("header label updates when filePath value becomes parseable", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // F1.1: label updates client-side once the full filePath value is extractable.
    sendDelta(ctx, "blk-title", '{"filePath":"', true, "✎ Writing...");
    sendDelta(ctx, "blk-title", 'src/core/runner.ts","patch":"', false, "");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const hdr = block.querySelector(".livecode-h");
    const lbl = hdr.querySelector(".label");
    expect(lbl.textContent).toBe("✎ Writing src/core/runner.ts...");
  });

  it("tool_result success → .ts-settled and '✓ Patched' label", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-settle", '{"filePath":"src/x.ts"}', true, "✎ Writing x.ts...");

    // Emit tool_result for apply_patch
    (ctx as { handleSSEPayload: (payload: unknown, runId: string) => void }).handleSSEPayload(
      { stage: "agent_loop", progress: { type: "tool_result", toolName: "apply_patch", status: "success", title: "ok", detail: "" } },
      RUN_ID
    );

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    expect(block.classList.contains("ts-settled")).toBe(true);
    expect(block.classList.contains("ts-failed")).toBe(false);
    const lbl = block.querySelector(".livecode-h").querySelector(".label");
    expect(lbl.textContent).toBe("✓ Patched");
  });

  it("tool_result error → .ts-failed and '✗ Write failed' label", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-fail", '{"filePath":"src/y.ts"}', true, "✎ Writing y.ts...");

    (ctx as { handleSSEPayload: (payload: unknown, runId: string) => void }).handleSSEPayload(
      { stage: "agent_loop", progress: { type: "tool_result", toolName: "apply_patch", status: "error", title: "fail", detail: "" } },
      RUN_ID
    );

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    expect(block.classList.contains("ts-failed")).toBe(true);
    expect(block.classList.contains("ts-settled")).toBe(false);
    const lbl = block.querySelector(".livecode-h").querySelector(".label");
    expect(lbl.textContent).toBe("✗ Write failed");
  });

  it("tool_result for non-write tool does not affect tool-stream blocks", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-nochange", '{"filePath":"src/z.ts"}', true, "✎ Writing z.ts...");

    // Emit a tool_result for read_file — should not settle the block
    (ctx as { handleSSEPayload: (payload: unknown, runId: string) => void }).handleSSEPayload(
      { stage: "agent_loop", progress: { type: "tool_result", toolName: "read_file", status: "success", title: "content", detail: "" } },
      RUN_ID
    );

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    expect(block.classList.contains("ts-settled")).toBe(false);
    expect(block.classList.contains("ts-failed")).toBe(false);
  });
});

describe("Phase F1.1 — incremental JSON parsing for typewriter render", () => {
  it("filePath extracted from accumulated JSON updates header label", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // The closing quote after the filePath value makes it extractable.
    sendDelta(ctx, "blk-fp1", '{"filePath":"src/utils/files.ts","patch":"', true, "✎ Writing...", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const lbl = block.querySelector(".livecode-h").querySelector(".label");
    expect(lbl.textContent).toBe("✎ Writing src/utils/files.ts...");
  });

  it("escaped newlines in patch JSON render as real newlines in pre", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // '\\n' in JS source = literal backslash-n (the JSON escape sequence for newline).
    sendDelta(ctx, "blk-esc1", '{"filePath":"src/a.ts","patch":"line1\\nline2"}', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    // '\n' in JS source = actual newline U+000A — the decoded result.
    expect(pre.textContent).toBe("line1\nline2");
  });

  it("truncated mid-string patch value does not crash and creates the block", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // Patch value is cut off mid-stream — no closing quote yet.
    sendDelta(ctx, "blk-trunc1", '{"filePath":"src/b.ts","patch":"partial con', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    expect(block).toBeTruthy();
    // Block exists and pre is present — content may be partial but no crash.
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    expect(pre).toBeTruthy();
  });

  it("complete JSON with escaped quote renders decoded patch in pre", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // '\\n' = literal \n, '\\"' = literal \" — both are JSON escape sequences.
    sendDelta(ctx, "blk-full1", '{"filePath":"src/c.ts","patch":"old line\\nnew \\"quoted\\" line"}', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    expect(pre.textContent).toContain("old line");
    expect(pre.textContent.includes("\n")).toBe(true);  // actual newline
    expect(pre.textContent).toContain('"quoted"');       // decoded backslash-quote
  });
});
