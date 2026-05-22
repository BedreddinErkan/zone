/**
 * Phase F1.3 — UI streaming moved to side-panel slot.
 *
 * F1/F1.1/F1.2 rendered the typewriter block inside the chat timeline.
 * F1.3 retires that and routes streaming content into a dedicated
 * `#zone-live-stream` slot inside the existing `.zone-todo-sidebar`,
 * below the sticky Plan widget.
 *
 * These tests cover the C1 / C2 / C3 deliverables together so the
 * paradigm shift is exercised end-to-end.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

class MockClassList {
  private classes = new Set<string>();
  constructor(initial = "") {
    for (const c of initial.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }
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
    if (this.children.length > 0) return this.children.map(c => c.textContent).join("");
    return this.textContentValue;
  }
  set textContent(v: string) {
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
  querySelector(sel?: string): MockElement | null {
    const found = this.querySelectorAll(sel ?? "")[0];
    return found ?? null;
  }
  querySelectorAll(sel: string): MockElement[] {
    const results: MockElement[] = [];
    const cm = sel.match(/^\.([A-Za-z0-9_-]+)$/);
    const im = sel.match(/^#([A-Za-z0-9_-]+)$/);
    const visit = (n: MockElement) => {
      for (const c of n.children) {
        if (cm && c.classList.contains(cm[1]!)) results.push(c);
        else if (im && c.id === im[1]) results.push(c);
        visit(c);
      }
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
  click() { for (const fn of (this.eventListeners.get('click') ?? [])) fn(); }
  dispatchScroll() { for (const fn of (this.eventListeners.get('scroll') ?? [])) fn(); }
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
    // F1.3: first walk the live DOM (body subtree) for elements created via
    // appendChild. Return null for the IDs we want the SUT to lazily
    // construct (`zoneTodoSidebar`, `zone-live-stream`). For all other
    // unknown IDs, fall back to ensureEl auto-create — the existing harness
    // behavior — so the script's bootstrap code keeps working.
    getElementById(id: string): MockElement | null {
      const stack: MockElement[] = [document.body];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur.id === id) return cur;
        for (const c of cur.children) stack.push(c);
      }
      if (id === "zoneTodoSidebar" || id === "zone-live-stream") return null;
      return ensureEl(id);
    },
    querySelector() { return null; },
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
  Object.assign(ctx, ctx.window);

  vm.runInNewContext(appScript, ctx);
  return { ctx, elements, ensureEl, document };
}

const RUN_ID = "run-f13-1";

function getSidebar(document: { body: MockElement }) {
  // ensureTodoSidebar appends to document.body — pick the first child with id zoneTodoSidebar.
  for (const c of document.body.children) if (c.id === "zoneTodoSidebar") return c;
  return null;
}

describe("Phase F1.3 — C1 side panel slot DOM structure", () => {
  it("ensureTodoSidebar creates the side panel with both child regions", () => {
    const { ctx, document } = buildHarness();
    (ctx as { ensureTodoSidebar: () => MockElement }).ensureTodoSidebar();
    const sidebar = getSidebar(document)!;
    expect(sidebar).toBeTruthy();
    // Plan host (sticky-top region) and live stream slot are both children.
    expect(sidebar.querySelectorAll(".zone-todo-plan").length).toBe(1);
    expect(sidebar.querySelectorAll(".zone-side-stream-slot").length).toBe(1);
  });

  it("live stream slot is hidden by default (no data-state)", () => {
    const { ctx, document } = buildHarness();
    (ctx as { ensureTodoSidebar: () => MockElement }).ensureTodoSidebar();
    const sidebar = getSidebar(document)!;
    const slot = sidebar.querySelectorAll(".zone-side-stream-slot")[0]!;
    expect(slot.dataset.state).toBeFalsy();
    // Slot has the structural sub-elements ready for C2 to populate.
    expect(slot.querySelectorAll(".ss-hdr").length).toBe(1);
    expect(slot.querySelectorAll(".ss-body").length).toBe(1);
    expect(slot.querySelectorAll(".ss-label").length).toBe(1);
    expect(slot.querySelectorAll(".ss-dot").length).toBe(1);
  });

  it("CSS pins side panel as flex column, Plan sticky, slot fixed max-height + violet border", () => {
    const css = readFileSync(path.resolve("src/ui/index.html"), "utf8");
    // Sidebar becomes flex column when visible.
    expect(css).toMatch(/\.zone-todo-sidebar\[data-state="visible"\]\{display:flex\}/);
    expect(css).toMatch(/\.zone-todo-sidebar\{[^}]*flex-direction:column/);
    // Plan content is sticky inside the panel.
    expect(css).toMatch(/\.zone-todo-plan\{[^}]*position:sticky;top:0/);
    // Slot is hidden when empty, fixed max-height, violet left border.
    expect(css).toMatch(/\.zone-side-stream-slot\{[^}]*display:none/);
    expect(css).toMatch(/\.zone-side-stream-slot\{[^}]*max-height:320px/);
    expect(css).toMatch(/\.zone-side-stream-slot\{[^}]*overflow-y:auto/);
    expect(css).toMatch(/\.zone-side-stream-slot\{[^}]*border-left:3px solid var\(--violet\)/);
    // data-state="active" reveals it as flex column.
    expect(css).toMatch(/\.zone-side-stream-slot\[data-state="active"\]\{display:flex\}/);
    // 150ms fade transition for the fade-out lifecycle.
    expect(css).toMatch(/\.zone-side-stream-slot\{[^}]*transition:opacity 150ms/);
  });

  it("ensureLiveStreamSlot returns the slot element", () => {
    const { ctx, document } = buildHarness();
    const slot = (ctx as { ensureLiveStreamSlot: () => MockElement }).ensureLiveStreamSlot();
    expect(slot).toBeTruthy();
    expect(slot.id).toBe("zone-live-stream");
    expect(slot.classList.contains("zone-side-stream-slot")).toBe(true);
    // Slot lives inside the sidebar that was lazily created.
    const sidebar = getSidebar(document)!;
    expect(slot.parentElement).toBe(sidebar);
  });
});

function sendDelta(
  ctx: Record<string, unknown>,
  blockId: string,
  delta: string,
  isFirstDelta: boolean,
  title = "",
  toolName = "apply_patch",
  runId = RUN_ID,
  subagentId?: string,
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
        ...(subagentId ? { subagentId } : {}),
      },
    },
    runId,
  );
}

function sendToolResult(
  ctx: Record<string, unknown>,
  toolName: string,
  status: "success" | "error" = "success",
  runId = RUN_ID,
) {
  (ctx as { handleSSEPayload: (payload: unknown, runId: string) => void }).handleSSEPayload(
    {
      stage: "agent_loop",
      progress: { type: "tool_result", toolName, status, title: "", detail: "" },
    },
    runId,
  );
}

function sendRunCompleted(ctx: Record<string, unknown>, runId = RUN_ID) {
  (ctx as { handleSSEPayload: (payload: unknown, runId: string) => void }).handleSSEPayload(
    { lifecycle: { type: "run_completed" } },
    runId,
  );
}

describe("Phase F1.3 — C2 streaming routes to side-panel slot", () => {
  it("first delta reveals slot + sidebar with header derived from title", () => {
    const { ctx, document } = buildHarness();
    sendDelta(ctx, "blk-1", '{"filePath":"src/a.ts"', true, "✎ Writing a.ts...");
    const sidebar = getSidebar(document)!;
    expect(sidebar.dataset.state).toBe("visible");
    const slot = sidebar.querySelectorAll(".zone-side-stream-slot")[0]!;
    expect(slot.dataset.state).toBe("active");
    const lbl = slot.querySelectorAll(".ss-label")[0]!;
    // First delta sets the initial title; later deltas overwrite once filePath parses out.
    expect(lbl.textContent.length).toBeGreaterThan(0);
  });

  it("label updates to ✎ Writing <filePath>… once filePath value parses", () => {
    const { ctx, document } = buildHarness();
    sendDelta(ctx, "blk-fp", '{"filePath":"', true, "✎ Writing...");
    sendDelta(ctx, "blk-fp", 'src/core/runner.ts","patch":"', false, "");
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    const lbl = slot.querySelectorAll(".ss-label")[0]!;
    expect(lbl.textContent).toBe("✎ Writing src/core/runner.ts...");
  });

  it("FIND/REPLACE patch renders -/+ diff inside the slot, markers stripped", () => {
    const { ctx, document } = buildHarness();
    sendDelta(
      ctx,
      "blk-diff",
      '{"filePath":"src/d.ts","patch":"--- FIND ---\\nold code\\n--- REPLACE ---\\nnew code"}',
      true,
      "",
      "apply_patch",
    );
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    const body = slot.querySelectorAll(".ss-body")[0]!;
    const dels = body.querySelectorAll(".stream-diff-removed");
    const adds = body.querySelectorAll(".stream-diff-added");
    expect(dels.length).toBe(1);
    expect(adds.length).toBe(1);
    expect(dels[0]!.textContent).toContain("old code");
    expect(adds[0]!.textContent).toContain("new code");
    // Marker text itself must not leak into the body.
    expect(body.textContent).not.toContain("--- FIND ---");
    expect(body.textContent).not.toContain("--- REPLACE ---");
  });

  it("tool_result starts the fade (data-state=fading), then clears after 150ms", async () => {
    const { ctx, document } = buildHarness();
    sendDelta(
      ctx,
      "blk-settle",
      '{"filePath":"src/x.ts","patch":"--- FIND ---\\nA\\n--- REPLACE ---\\nB"}',
      true,
      "",
      "apply_patch",
    );
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    expect(slot.dataset.state).toBe("active");
    sendToolResult(ctx, "apply_patch", "success");
    expect(slot.dataset.state).toBe("fading");
    // Wait past the 150ms transition.
    await new Promise((r) => setTimeout(r, 200));
    expect(slot.dataset.state).toBe("");
    const body = slot.querySelectorAll(".ss-body")[0]!;
    expect(body.innerHTML).toBe("");
  });

  it("a second isFirstDelta while slot is occupied replaces content immediately", () => {
    const { ctx, document } = buildHarness();
    sendDelta(
      ctx,
      "blk-A",
      '{"filePath":"src/A.ts","patch":"--- FIND ---\\nA\\n--- REPLACE ---\\nA2"}',
      true,
      "",
      "apply_patch",
    );
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    const body = slot.querySelectorAll(".ss-body")[0]!;
    expect(body.textContent).toContain("A");
    // New stream starts (no fade) — should overwrite the old content.
    sendDelta(
      ctx,
      "blk-B",
      '{"filePath":"src/B.ts","patch":"--- FIND ---\\nB\\n--- REPLACE ---\\nB2"}',
      true,
      "",
      "apply_patch",
    );
    expect(slot.dataset.state).toBe("active");
    expect(body.textContent).not.toContain("A2");
    expect(body.textContent).toContain("B2");
  });

  it("run_completed defensively clears a stuck slot", () => {
    const { ctx, document } = buildHarness();
    sendDelta(
      ctx,
      "blk-stuck",
      '{"filePath":"src/q.ts","patch":"--- FIND ---\\nQ\\n--- REPLACE ---\\nQ2"}',
      true,
      "",
      "apply_patch",
    );
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    expect(slot.dataset.state).toBe("active");
    // No tool_result fired — agent_finished arrives directly.
    sendRunCompleted(ctx);
    expect(slot.dataset.state).toBe("");
    const body = slot.querySelectorAll(".ss-body")[0]!;
    expect(body.innerHTML).toBe("");
  });

  it("auto-scrolls slot to bottom on each delta when user is at bottom", () => {
    const { ctx, document } = buildHarness();
    sendDelta(ctx, "blk-sc", '{"filePath":"src/s.ts","patch":"--- FIND ---\\nA', true, "", "apply_patch");
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    slot.scrollHeight = 600;
    slot.clientHeight = 320;
    slot.scrollTop = 0;
    sendDelta(ctx, "blk-sc", '\\n--- REPLACE ---\\nB"}', false, "", "apply_patch");
    expect(slot.scrollTop).toBe(slot.scrollHeight);
  });

  it("auto-scroll pauses once the user scrolls up", () => {
    const { ctx, document } = buildHarness();
    sendDelta(ctx, "blk-pause", '{"filePath":"src/p.ts","patch":"--- FIND ---\\nA', true, "", "apply_patch");
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    slot.scrollHeight = 800;
    slot.clientHeight = 320;
    slot.scrollTop = 100; // user scrolled up
    slot.dispatchScroll();
    sendDelta(ctx, "blk-pause", '\\n--- REPLACE ---\\nB"}', false, "", "apply_patch");
    expect(slot.scrollTop).toBe(100);
  });

  it("chat timeline never receives a .tool-stream-block (F1.x widget retired)", () => {
    const { ctx, ensureEl, document } = buildHarness();
    const logBlock = ensureEl(`logBlock-${RUN_ID}`);
    sendDelta(
      ctx,
      "blk-chat",
      '{"filePath":"src/c.ts","patch":"--- FIND ---\\nA\\n--- REPLACE ---\\nB"}',
      true,
      "",
      "apply_patch",
    );
    // Old chat-embedded widget class name — must not appear anywhere in logBlock.
    expect(logBlock.querySelectorAll(".tool-stream-block").length).toBe(0);
    expect(logBlock.querySelectorAll(".livecode").length).toBe(0);
    // Slot got the content instead.
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    expect(slot.dataset.state).toBe("active");
  });
});

describe("Phase F1.4 — worker prefix in side-panel slot", () => {
  it("event with subagentId renders the '↳ worker {id-short}' prefix on the label", () => {
    const { ctx, document } = buildHarness();
    sendDelta(
      ctx,
      "blk-w1",
      '{"filePath":"src/w.ts","patch":"--- FIND ---\\nA\\n--- REPLACE ---\\nB"}',
      true,
      "↳ worker abc123 ✎ Writing...", // server-side title already prefixed
      "apply_patch",
      RUN_ID,
      "abc1234567",
    );
    const sidebar = getSidebar(document)!;
    const slot = sidebar.querySelectorAll(".zone-side-stream-slot")[0]!;
    const lbl = slot.querySelectorAll(".ss-label")[0]!;
    // After filePath parses out, the UI rebuilds the label — must preserve the worker prefix.
    expect(lbl.textContent.startsWith("↳ worker abc123 ")).toBe(true);
    expect(lbl.textContent).toContain("Writing src/w.ts");
  });

  it("event without subagentId keeps the parent label format", () => {
    const { ctx, document } = buildHarness();
    sendDelta(
      ctx,
      "blk-p1",
      '{"filePath":"src/p.ts","patch":"--- FIND ---\\nA\\n--- REPLACE ---\\nB"}',
      true,
      "✎ Writing...",
      "apply_patch",
      RUN_ID,
      // no subagentId — parent stream
    );
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    const lbl = slot.querySelectorAll(".ss-label")[0]!;
    expect(lbl.textContent.startsWith("↳ worker")).toBe(false);
    expect(lbl.textContent).toBe("✎ Writing src/p.ts...");
  });

  it("worker → parent → worker sequence transitions without leaking worker prefix into the parent block", () => {
    const { ctx, document } = buildHarness();
    // Worker A
    sendDelta(
      ctx,
      "blk-wA",
      '{"filePath":"src/A.ts","patch":"--- FIND ---\\nA\\n--- REPLACE ---\\nA2"}',
      true,
      "",
      "apply_patch",
      RUN_ID,
      "wA-aaaaaa",
    );
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    let lbl = slot.querySelectorAll(".ss-label")[0]!;
    expect(lbl.textContent).toContain("↳ worker wA-aaa");
    expect(lbl.textContent).toContain("src/A.ts");

    // Parent takes over (new isFirstDelta, no subagentId)
    sendDelta(
      ctx,
      "blk-parent",
      '{"filePath":"src/P.ts","patch":"--- FIND ---\\nP\\n--- REPLACE ---\\nP2"}',
      true,
      "✎ Writing...",
      "apply_patch",
      RUN_ID,
    );
    lbl = slot.querySelectorAll(".ss-label")[0]!;
    expect(lbl.textContent.startsWith("↳ worker")).toBe(false);
    expect(lbl.textContent).toContain("src/P.ts");

    // Worker B
    sendDelta(
      ctx,
      "blk-wB",
      '{"filePath":"src/B.ts","patch":"--- FIND ---\\nB\\n--- REPLACE ---\\nB2"}',
      true,
      "",
      "apply_patch",
      RUN_ID,
      "wB-bbbbbb",
    );
    lbl = slot.querySelectorAll(".ss-label")[0]!;
    expect(lbl.textContent).toContain("↳ worker wB-bbb");
    expect(lbl.textContent).toContain("src/B.ts");
  });

  it("worker prefix survives intra-stream filePath rebuild (server prefix may be lost in mid-stream rebuilds)", () => {
    // First delta: title set; no filePath parses yet.
    const { ctx, document } = buildHarness();
    sendDelta(ctx, "blk-rebuild", '{"filePath":"', true, "↳ worker xx Writing...", "apply_patch", RUN_ID, "xxxxxxxx");
    // Second delta: filePath value completes → UI rebuilds label from scratch.
    sendDelta(ctx, "blk-rebuild", 'src/r.ts","patch":"x"}', false, "", "apply_patch", RUN_ID, "xxxxxxxx");
    const slot = getSidebar(document)!.querySelectorAll(".zone-side-stream-slot")[0]!;
    const lbl = slot.querySelectorAll(".ss-label")[0]!;
    // Rebuild must still carry the worker prefix derived from the stored subagentId.
    expect(lbl.textContent.startsWith("↳ worker xxxxxx ")).toBe(true);
    expect(lbl.textContent).toContain("src/r.ts");
  });
});

export { buildHarness, MockElement, RUN_ID, getSidebar };
