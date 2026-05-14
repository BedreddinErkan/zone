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
  // F1.2: scroll properties — defaults to 0, tests can set scrollHeight/clientHeight
  // to simulate overflowing content and assert scrollTop is advanced.
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  private classListValue: MockClassList;
  private textContentValue = "";
  private innerHtmlValue = "";
  private eventListeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(id: string, className = "") {
    this.id = id;
    this.classListValue = new MockClassList(className);
  }

  get classList() { return this.classListValue; }
  get className() { return this.classListValue.toString(); }
  set className(v: string) { this.classListValue.setFromString(v); }
  get textContent(): string {
    // DOM-like: when there are children, concatenate their textContent; otherwise own value.
    if (this.children.length > 0) return this.children.map(c => c.textContent).join("");
    return this.textContentValue;
  }
  set textContent(v: string) {
    // DOM-like: setting textContent replaces all children with a single text node.
    this.textContentValue = String(v ?? "");
    this.children = [];
  }
  get innerHTML() { return this.innerHtmlValue; }
  set innerHTML(v: string) {
    this.innerHtmlValue = String(v ?? "");
    this.textContentValue = v.replace(/<[^>]*>/g, "");
    if (!v) this.children = [];
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
  addEventListener(type: string, fn: (...args: unknown[]) => void) {
    if (!this.eventListeners.has(type)) this.eventListeners.set(type, []);
    this.eventListeners.get(type)!.push(fn);
  }
  removeEventListener(type: string, fn: (...args: unknown[]) => void) {
    const fns = this.eventListeners.get(type) ?? [];
    this.eventListeners.set(type, fns.filter(f => f !== fn));
  }
  setAttribute(name: string, value: string) { if (name === "class") this.className = value; }
  getAttribute(name: string) { return this.dataset[name] ?? null; }
  click() {
    for (const fn of (this.eventListeners.get('click') ?? [])) fn();
  }
  dispatchScroll() {
    for (const fn of (this.eventListeners.get('scroll') ?? [])) fn();
  }
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
    sendDelta(ctx, "blk-grow", '\\nfoo\\n--- REPLACE ---\\nbar"}', false, "✎ Writing a.ts...");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    expect(pre!.textContent!.length).toBeGreaterThan(0);
    // F1.2: markers are stripped, content rendered with -/+ prefixes
    expect(pre!.textContent).not.toContain("--- FIND ---");
    expect(pre!.textContent).not.toContain("--- REPLACE ---");
    expect(pre!.textContent).toContain("foo");
    expect(pre!.textContent).toContain("bar");
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
    // F1.1 C3: label now shows filePath instead of generic "Patched"
    expect(lbl.textContent).toContain("✓");
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
    // F1.1 C3: label now shows filePath instead of generic "Write failed"
    expect(lbl.textContent).toContain("✗");
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

  // F1.2 — FIND/REPLACE markers stripped, diff prefix render
  it("FIND/REPLACE patch renders del lines and add lines as separate spans", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // Real apply_patch markers: '--- FIND ---' / '--- REPLACE ---'.
    sendDelta(ctx, "blk-diff1", '{"filePath":"src/e.ts","patch":"--- FIND ---\\nold code\\n--- REPLACE ---\\nnew code"}', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    const delLines = pre.querySelectorAll(".ts-del");
    const addLines = pre.querySelectorAll(".ts-add");
    expect(delLines.length).toBe(1);
    expect(addLines.length).toBe(1);
    expect(delLines[0]!.textContent).toContain("old code");
    expect(addLines[0]!.textContent).toContain("new code");
    // F1.2: '-' / '+' prefixes are present
    expect(delLines[0]!.textContent!.startsWith("- ")).toBe(true);
    expect(addLines[0]!.textContent!.startsWith("+ ")).toBe(true);
    // F1.2: marker text itself never appears in the rendered DOM
    expect(pre.textContent).not.toContain("--- FIND ---");
    expect(pre.textContent).not.toContain("--- REPLACE ---");
  });

  it("add-only patch (empty FIND section) renders only green add lines", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-addonly", '{"filePath":"src/f.ts","patch":"--- FIND ---\\n--- REPLACE ---\\nnew code here"}', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    expect(pre.querySelectorAll(".ts-del").length).toBe(0);
    expect(pre.querySelectorAll(".ts-add").length).toBe(1);
    expect(pre.querySelectorAll(".ts-add")[0]!.textContent).toContain("new code here");
    expect(pre.textContent).not.toContain("--- REPLACE ---");
  });

  it("patch with no FIND/REPLACE markers renders as plain text in pre", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-raw1", '{"filePath":"src/d.ts","patch":"plain text content"}', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    expect(pre.textContent).toBe("plain text content");
    expect(pre.querySelectorAll(".ts-del").length).toBe(0);
    expect(pre.querySelectorAll(".ts-add").length).toBe(0);
  });

  // F1.2 — partial stream upgrades from plain → diff once REPLACE marker arrives
  it("partial patch missing REPLACE marker renders FIND content as plain", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // Only --- FIND --- has arrived; --- REPLACE --- still streaming.
    sendDelta(ctx, "blk-partial", '{"filePath":"src/p.ts","patch":"--- FIND ---\\nfirst line\\nsecond', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    // No diff spans yet — content is still plain text (no upgrade).
    expect(pre.querySelectorAll(".ts-del").length).toBe(0);
    expect(pre.querySelectorAll(".ts-add").length).toBe(0);
    expect(pre.querySelectorAll(".stream-diff-line").length).toBe(0);
  });

  it("partial patch upgrades to diff render once REPLACE marker arrives", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // First delta: only FIND marker present.
    sendDelta(ctx, "blk-upgrade", '{"filePath":"src/u.ts","patch":"--- FIND ---\\nold', true, "", "apply_patch");
    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    expect(pre.querySelectorAll(".stream-diff-line").length).toBe(0);  // still plain

    // Second delta: REPLACE marker + content arrives.
    sendDelta(ctx, "blk-upgrade", '\\n--- REPLACE ---\\nnew"}', false, "", "apply_patch");
    // Now upgraded to diff render.
    expect(pre.querySelectorAll(".ts-del").length).toBe(1);
    expect(pre.querySelectorAll(".ts-add").length).toBe(1);
    expect(pre.textContent).not.toContain("--- FIND ---");
    expect(pre.textContent).not.toContain("--- REPLACE ---");
  });

  it("diff spans get both new stream-diff-* and legacy ts-del/ts-add class names", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-cls", '{"filePath":"src/cls.ts","patch":"--- FIND ---\\nA\\n--- REPLACE ---\\nB"}', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const pre = block.querySelectorAll(".ts-code-pre")[0]!;
    // Both selectors should match the same element set.
    expect(pre.querySelectorAll(".stream-diff-removed").length).toBe(pre.querySelectorAll(".ts-del").length);
    expect(pre.querySelectorAll(".stream-diff-added").length).toBe(pre.querySelectorAll(".ts-add").length);
  });

  // F1.1 Commit 3 — auto-collapse completed blocks
  it("block collapses on tool_result and shows chevron", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-coll1", '{"filePath":"src/g.ts","patch":"--- FIND ---\\nold\\n--- REPLACE ---\\nnew"}', true, "", "apply_patch");
    (ctx as { handleSSEPayload: (p: unknown, r: string) => void }).handleSSEPayload(
      { stage: "agent_loop", progress: { type: "tool_result", toolName: "apply_patch", status: "success", title: "", detail: "" } },
      RUN_ID
    );

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    expect(block.classList.contains("ts-collapsed")).toBe(true);
    expect(block.classList.contains("ts-settled")).toBe(true);
    // Chevron should be visible after settlement
    const chevron = block.querySelectorAll(".ts-chevron")[0]!;
    expect(chevron.style.display).not.toBe("none");
  });

  it("click on chevron expands the collapsed block", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-coll2", '{"filePath":"src/h.ts","patch":"--- FIND ---\\nold\\n--- REPLACE ---\\nnew"}', true, "", "apply_patch");
    (ctx as { handleSSEPayload: (p: unknown, r: string) => void }).handleSSEPayload(
      { stage: "agent_loop", progress: { type: "tool_result", toolName: "apply_patch", status: "success", title: "", detail: "" } },
      RUN_ID
    );

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const chevron = block.querySelectorAll(".ts-chevron")[0]!;
    chevron.click(); // expand
    expect(block.classList.contains("ts-collapsed")).toBe(false);
    expect(chevron.textContent).toBe("▼");
  });

  it("second chevron click re-collapses the block", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-coll3", '{"filePath":"src/i.ts","patch":"--- FIND ---\\nold\\n--- REPLACE ---\\nnew"}', true, "", "apply_patch");
    (ctx as { handleSSEPayload: (p: unknown, r: string) => void }).handleSSEPayload(
      { stage: "agent_loop", progress: { type: "tool_result", toolName: "apply_patch", status: "success", title: "", detail: "" } },
      RUN_ID
    );

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const chevron = block.querySelectorAll(".ts-chevron")[0]!;
    chevron.click(); // expand
    chevron.click(); // collapse again
    expect(block.classList.contains("ts-collapsed")).toBe(true);
    expect(chevron.textContent).toBe("▶");
  });

  it("new isFirstDelta auto-collapses previous unsettled blocks", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // First block starts streaming (not settled yet)
    sendDelta(ctx, "blk-auto1", '{"filePath":"src/j.ts","patch":"--- FIND ---\\nold\\n--- REPLACE ---\\nnew"}', true, "", "apply_patch");
    const firstBlock = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    expect(firstBlock.classList.contains("ts-collapsed")).toBe(false); // not collapsed yet

    // Second block starts — first should auto-collapse
    sendDelta(ctx, "blk-auto2", '{"filePath":"src/k.ts","patch":"--- FIND ---\\nold2\\n--- REPLACE ---\\nnew2"}', true, "", "apply_patch");
    expect(firstBlock.classList.contains("ts-collapsed")).toBe(true);  // now auto-collapsed
    const blocks = logBlock.querySelectorAll(".tool-stream-block");
    expect(blocks.length).toBe(2);
    expect(blocks[1]!.classList.contains("ts-collapsed")).toBe(false); // new block not collapsed
  });
});

describe("Phase F1.2 — fixed-height container with internal scroll", () => {
  it("body has livecode-body class (CSS pins max-height + overflow-y:auto)", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-css1", '{"filePath":"src/a.ts","patch":"--- FIND ---\\nA\\n--- REPLACE ---\\nB"}', true, "", "apply_patch");

    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const body = block.querySelectorAll(".livecode-body")[0];
    expect(body).toBeTruthy();
    // CSS for .tool-stream-block .livecode-body sets max-height:320px and overflow-y:auto.
    const css = readFileSync(path.resolve("src/ui/index.html"), "utf8");
    expect(css).toMatch(/\.tool-stream-block \.livecode-body\{[^}]*max-height:320px/);
    expect(css).toMatch(/\.tool-stream-block \.livecode-body\{[^}]*overflow-y:auto/);
  });

  it("streaming auto-scrolls body to bottom on each delta", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    // First delta — create block; body has measurable scrollHeight after content.
    sendDelta(ctx, "blk-scroll1", '{"filePath":"src/x.ts","patch":"--- FIND ---\\nL1\\nL2\\nL3', true, "", "apply_patch");
    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const body = block.querySelectorAll(".livecode-body")[0]!;

    // Simulate overflowing content + the user is at the bottom.
    body.scrollHeight = 600;
    body.clientHeight = 320;
    body.scrollTop = 0;

    // Send another delta — handler should auto-scroll body to bottom.
    sendDelta(ctx, "blk-scroll1", '\\n--- REPLACE ---\\nR1\\nR2"}', false, "", "apply_patch");

    expect(body.scrollTop).toBe(body.scrollHeight);
  });

  it("auto-scroll pauses once the user scrolls away from the bottom", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-pause1", '{"filePath":"src/y.ts","patch":"--- FIND ---\\nA', true, "", "apply_patch");
    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const body = block.querySelectorAll(".livecode-body")[0]!;

    // User scrolls up: scrollTop far from scrollHeight - clientHeight → not at bottom.
    body.scrollHeight = 800;
    body.clientHeight = 320;
    body.scrollTop = 100;
    body.dispatchScroll();

    // Next delta arrives; auto-scroll should NOT advance scrollTop.
    sendDelta(ctx, "blk-pause1", '\\n--- REPLACE ---\\nB"}', false, "", "apply_patch");

    expect(body.scrollTop).toBe(100);
  });

  it("auto-scroll resumes when user scrolls back near the bottom", () => {
    const { ctx, ensureEl } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);

    sendDelta(ctx, "blk-resume1", '{"filePath":"src/z.ts","patch":"--- FIND ---\\nA', true, "", "apply_patch");
    const block = logBlock.querySelectorAll(".tool-stream-block")[0]!;
    const body = block.querySelectorAll(".livecode-body")[0]!;

    body.scrollHeight = 800;
    body.clientHeight = 320;
    // First: user scrolls up — auto-scroll paused.
    body.scrollTop = 100;
    body.dispatchScroll();
    // Then: user scrolls back to within 16px of the bottom.
    body.scrollTop = 800 - 320 - 8;
    body.dispatchScroll();

    // Next delta auto-scrolls to the bottom again.
    sendDelta(ctx, "blk-resume1", '\\n--- REPLACE ---\\nB"}', false, "", "apply_patch");
    expect(body.scrollTop).toBe(body.scrollHeight);
  });
});
