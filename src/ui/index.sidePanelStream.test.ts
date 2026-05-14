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

export { buildHarness, MockElement, RUN_ID, getSidebar };
