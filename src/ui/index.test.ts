import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

class MockClassList {
  private classes = new Set<string>();

  constructor(initial = "") {
    for (const className of initial.split(/\s+/).filter(Boolean)) {
      this.classes.add(className);
    }
  }

  add(...names: string[]): void {
    for (const name of names) this.classes.add(name);
  }

  remove(...names: string[]): void {
    for (const name of names) this.classes.delete(name);
  }

  toggle(name: string, force?: boolean): boolean {
    if (force === true) {
      this.classes.add(name);
      return true;
    }
    if (force === false) {
      this.classes.delete(name);
      return false;
    }
    if (this.classes.has(name)) {
      this.classes.delete(name);
      return false;
    }
    this.classes.add(name);
    return true;
  }

  contains(name: string): boolean {
    return this.classes.has(name);
  }

  setFromString(value: string): void {
    this.classes = new Set(value.split(/\s+/).filter(Boolean));
  }

  toString(): string {
    return [...this.classes].join(" ");
  }
}

class MockElement {
  id: string;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  readOnly = false;
  value = "";
  placeholder = "";
  title = "";
  disabled = false;
  hidden = false;
  offsetHeight = 0;
  files: Array<{ name?: string; webkitRelativePath?: string }> = [];
  clicked = false;
  dataset: Record<string, string> = {};
  private listeners = new Map<string, Array<(event?: unknown) => void>>();
  private classListValue: MockClassList;
  private textContentValue = "";
  private innerHtmlValue = "";

  constructor(id: string, className = "") {
    this.id = id;
    this.classListValue = new MockClassList(className);
  }

  get classList(): MockClassList {
    return this.classListValue;
  }

  get className(): string {
    return this.classListValue.toString();
  }

  set className(value: string) {
    this.classListValue.setFromString(value);
  }

  get textContent(): string {
    return this.textContentValue;
  }

  set textContent(value: string) {
    this.textContentValue = String(value ?? "");
  }

  get innerText(): string {
    return this.textContentValue;
  }

  set innerText(value: string) {
    this.textContent = value;
  }

  get innerHTML(): string {
    return this.innerHtmlValue;
  }

  set innerHTML(value: string) {
    this.innerHtmlValue = String(value ?? "");
    this.textContentValue = htmlToText(this.innerHtmlValue);
    this.children = [];
    const optionRe =
      /<div\b([^>]*class="[^"]*\bzone-dropdown-option\b[^"]*"[^>]*)>/gi;
    let match: RegExpExecArray | null;
    let idx = 0;
    while ((match = optionRe.exec(this.innerHtmlValue))) {
      const attr = match[1] || "";
      const child = new MockElement(`${this.id}-option-${idx}`, "zone-dropdown-option");
      const valueMatch = attr.match(/\bdata-value="([^"]*)"/i);
      if (valueMatch) child.dataset.value = valueMatch[1];
      child.parentElement = this;
      this.children.push(child);
      idx += 1;
    }
  }

  click(): void {
    this.clicked = true;
    for (const listener of this.listeners.get("click") ?? []) {
      listener({ target: this });
    }
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: string, listener: (event?: unknown) => void): void {
    const current = this.listeners.get(type);
    if (!current) return;
    this.listeners.set(
      type,
      current.filter((candidate) => candidate !== listener)
    );
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === "title") {
      this.title = value;
    }
    if (name === "class") {
      this.className = value;
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  appendChild(child: MockElement): MockElement {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  contains(candidate: unknown): boolean {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  focus(): void {
    // no-op for test harness
  }

  querySelector(selector?: string): MockElement {
    const found = this.querySelectorAll(selector || "")[0];
    if (found) return found;
    const classMatch = selector?.match(/^\.([A-Za-z0-9_-]+)$/);
    const child = new MockElement(
      `${this.id}-${classMatch ? classMatch[1] : "query"}`,
      classMatch ? classMatch[1] : ""
    );
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  querySelectorAll(selector: string): MockElement[] {
    const classMatch = selector.match(/^\.([A-Za-z0-9_-]+)$/);
    if (!classMatch) return [];
    const className = classMatch[1];
    const results: MockElement[] = [];
    const visit = (node: MockElement) => {
      for (const child of node.children) {
        if (child.classList.contains(className)) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }

  scrollIntoView(): void {
    // no-op for test harness
  }
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  emit(data: unknown): void {
    this.onmessage?.({
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
  }

  close(): void {
    this.closed = true;
  }
}

class MockWritableFile {
  private fileHandle: MockFileHandle;
  written = "";

  constructor(fileHandle: MockFileHandle) {
    this.fileHandle = fileHandle;
  }

  async write(value: string): Promise<void> {
    this.written = value;
    this.fileHandle.content = value;
  }

  async close(): Promise<void> {
    // no-op
  }
}

class MockFileHandle {
  kind = "file";
  name = "";
  content = "";
  writable = new MockWritableFile(this);

  constructor(name = "") {
    this.name = name;
  }

  async createWritable(): Promise<MockWritableFile> {
    return this.writable;
  }

  async getFile(): Promise<{ size: number; text(): Promise<string> }> {
    return {
      size: this.content.length,
      text: async () => this.content,
    };
  }
}

class MockDirectoryHandle {
  kind = "directory";
  name: string;
  permissionState: "granted" | "denied" | "prompt";
  directories = new Map<string, MockDirectoryHandle>();
  files = new Map<string, MockFileHandle>();

  constructor(
    name: string,
    permissionState: "granted" | "denied" | "prompt" = "granted"
  ) {
    this.name = name;
    this.permissionState = permissionState;
  }

  async queryPermission(): Promise<"granted" | "denied" | "prompt"> {
    return this.permissionState;
  }

  async requestPermission(): Promise<"granted" | "denied" | "prompt"> {
    return this.permissionState;
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<MockDirectoryHandle> {
    if (!this.directories.has(name)) {
      if (!options?.create) {
        throw new Error(`Directory not found: ${name}`);
      }
      this.directories.set(name, new MockDirectoryHandle(name, this.permissionState));
    }
    return this.directories.get(name)!;
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean }
  ): Promise<MockFileHandle> {
    if (!this.files.has(name)) {
      if (!options?.create) {
        throw new Error(`File not found: ${name}`);
      }
      this.files.set(name, new MockFileHandle(name));
    }
    return this.files.get(name)!;
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
  }

  async *values(): AsyncGenerator<MockDirectoryHandle | MockFileHandle> {
    for (const [name, directory] of this.directories) {
      directory.name = name;
      yield directory;
    }
    for (const [name, file] of this.files) {
      file.name = name;
      yield file;
    }
  }
}

type UiDecisionInput = {
  decision?: { mode?: string };
  confidence?: { score?: number };
  risk?: { score?: number; breakdown?: Record<string, number> };
  frameworkBadge?: string;
  complexity?: string;
};

type UiPatchInput = {
  ok: boolean;
  patchPreview?: string;
  warnings?: string[];
  contextFiles?: string[];
  applyPatches?: Array<{ filePath: string; fullContent: string }>;
  validationBlocked?: boolean;
};

type UiRun = {
  task: string;
  role: string;
  repoPath: string;
  status: string;
  timestamp: number;
};

type UiContext = {
  document: {
    getElementById(id: string): MockElement;
    querySelector(selector?: string): MockElement;
    querySelectorAll(selector: string): MockElement[];
  };
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  navigator: {
    clipboard: {
      writeText(value: string): Promise<void>;
    };
  };
  console: Console;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  fetch: ReturnType<typeof vi.fn>;
  EventSource: typeof MockEventSource;
  window: {
    location: { href: string };
    showDirectoryPicker?: ReturnType<typeof vi.fn>;
    parent?: { postMessage(message: unknown, targetOrigin: string): void };
    top?: unknown;
    currentUser?: { id: string; email?: string };
    Clerk?: {
      user?: { id?: string };
      session?: { user?: { id?: string } };
    };
    __ZONE_PUBLIC_CONFIG__?: {
      zoneApiBaseUrl?: string;
      debugFallbackUserId?: string;
      currentUser?: { id: string; email?: string } | null;
    };
  };
  Math: Math;
  Date: DateConstructor;
  encodeURIComponent: typeof encodeURIComponent;
  showDecision(data: UiDecisionInput): void;
  resetUI(): void;
  selectRole(button: MockElement): void;
  showPatch(data: UiPatchInput): void;
  execute(): Promise<void>;
  executeDryRun(): Promise<void>;
  applyChanges(): Promise<void>;
  restorePreviousState(): Promise<void>;
  addRecentRun(run: UiRun): void;
  loadRecentRun(index: number): void;
  setProgress(stage: string): void;
  selectRepoFolder(): Promise<void>;
  handleFolderFallbackChange(input: MockElement): void;
  refreshBillingSummary(): Promise<void>;
  getEffectiveDiffState(result: unknown): {
    totalChangedLines: number;
    allDiffPatchesEmpty: boolean;
    effectiveDiffsEmpty: boolean;
  };
  cacheClass(ratio: number): string;
  setRun(threadId: string, runState: { runId: string; todos?: unknown[] } | null): void;
  clearRun(threadId: string): void;
  activateThread(threadId: string): void;
  setTodosForRun(runId: string, todos: unknown[]): void;
  updateTodoStatusForRun(runId: string, todoId: string, status: string): void;
  renderTodoSidebar(): void;
};

type UiContextBase = Omit<
  UiContext,
  | "showDecision"
  | "resetUI"
  | "selectRole"
  | "showPatch"
  | "execute"
  | "executeDryRun"
  | "applyChanges"
  | "restorePreviousState"
  | "addRecentRun"
  | "loadRecentRun"
  | "setProgress"
  | "selectRepoFolder"
  | "handleFolderFallbackChange"
>;

function okResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

function deniedResponse(status: number, body: unknown) {
  return {
    ok: false,
    status,
    json: async () => body,
  };
}

function developerPatchResponse(body: Record<string, unknown> = {}) {
  return {
    ok: true,
    patchPreview: "Summary: Fix login flow",
    decisionMode: "safe_to_apply",
    developerConfidence: 82,
    developerRisk: {
      score: 0,
      breakdown: { destructive: 0, schema: 0, massScope: 0 },
    },
    warnings: [],
    applyPatches: [
      {
        filePath: "src/features/login.ts",
        fullContent: "export const login = true;",
      },
    ],
    ...body,
  };
}

function queueDeveloperAsyncRun(
  fetchMock: ReturnType<typeof vi.fn>,
  result: Record<string, unknown> = developerPatchResponse(),
  options: {
    runId?: string;
    progressStage?: string;
    billingResponse?: Record<string, unknown>;
  } = {}
) {
  const runId = options.runId ?? "job_123";
  fetchMock
    .mockResolvedValueOnce(okResponse({ ok: true }))
    .mockResolvedValueOnce(okResponse({ ok: true, runId, status: "queued" }))
    .mockResolvedValueOnce(
      okResponse({
        ok: true,
        runId,
        status: "completed",
        progressStage: options.progressStage ?? "Ready",
        errorMessage: null,
      })
    )
    .mockResolvedValueOnce(okResponse(result))
    .mockResolvedValueOnce(
      okResponse(
        options.billingResponse ?? {
          ok: true,
          plan: "Free",
          credits: 10,
          subscriptionStatus: "free",
        }
      )
    );
  return fetchMock;
}

function buildUiHarness(initialLocalStorage: Record<string, string> = {}) {
  const html = readFileSync(
    path.resolve("src/ui/index.html"),
    "utf8"
  );
  const scriptContents = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  if (scriptContents.length === 0) {
    throw new Error("UI script not found");
  }
  const appScript = scriptContents.join("\n\n");

  const elements = new Map<string, MockElement>();
  const ensureElement = (id: string, className = ""): MockElement => {
    if (!elements.has(id)) {
      elements.set(id, new MockElement(id, className));
    }
    return elements.get(id)!;
  };

  ensureElement("historyBox", "hidden");
  ensureElement("historySelect");
  ensureElement("recentRunsSection");
  ensureElement("recentRunsEmpty");
  ensureElement("recentRunsList", "hidden");
  ensureElement("decisionSection", "hidden");
  ensureElement("patchSection", "hidden");
  ensureElement("resultSummaryBox");
  ensureElement("resultSummaryTitle");
  ensureElement("resultSummarySubtitle");
  ensureElement("resultSummaryChips");
  ensureElement("errorBox");
  ensureElement("warningsList", "hidden");
  ensureElement("successBox");
  ensureElement("contextFilesBox", "hidden");
  ensureElement("contextFilesList");
  ensureElement("task");
  ensureElement("repoPath");
  ensureElement("folderPickerBtn");
  ensureElement("folderPickerFallback", "hidden");
  ensureElement("repoSelectionBox", "hidden");
  ensureElement("repoSelectionLabel");
  ensureElement("repoSelectionMeta");
  ensureElement("billingSummaryBox", "hidden");
  ensureElement("billingSummaryLabel");
  ensureElement("billingSummaryMeta");
  ensureElement("complexityBadge", "complexity-badge hidden");
  ensureElement("frameworkBadge", "framework-badge hidden");
  ensureElement("decisionBadge", "decision-badge safe");
  ensureElement("bdot");
  ensureElement("badgeText");
  ensureElement("confVal");
  ensureElement("riskVal");
  ensureElement("filesVal");
  ensureElement("rDestructive");
  ensureElement("rDestructiveVal");
  ensureElement("rSchema");
  ensureElement("rSchemaVal");
  ensureElement("rMass");
  ensureElement("rMassVal");
  ensureElement("fileList");
  ensureElement("patchSummary");
  ensureElement("applyStatusBox");
  ensureElement("execBtn");
  ensureElement("spinner");
  ensureElement("execText");
  ensureElement("applyBtn");
  ensureElement("applySpinner");
  ensureElement("applyText");
  ensureElement("restoreBtn", "hidden");
  ensureElement("restoreSpinner");
  ensureElement("restoreText");
  ensureElement("progressBox", "progress-box hidden");
  ensureElement("progressText");
  ensureElement("dryRunBtn");
  ensureElement("drySpinner");
  ensureElement("dryRunText");
  ensureElement("diffSection", "hidden");
  ensureElement("diffSummaryBox");
  ensureElement("diffFileList");

  const developerRoleButton = new MockElement("developerRole", "role-btn");
  developerRoleButton.dataset.role = "developer";
  const testEngineerRoleButton = new MockElement("testEngineerRole", "role-btn");
  testEngineerRoleButton.dataset.role = "test_engineer";
  const dataAnalystRoleButton = new MockElement("dataAnalystRole", "role-btn");
  dataAnalystRoleButton.dataset.role = "data_analyst";
  const roleButtons = [
    developerRoleButton,
    testEngineerRoleButton,
    dataAnalystRoleButton,
  ];

  const promptBox = new MockElement("promptBox", "prompt-box");
  promptBox.innerText =
    "You are a code agent. Analyze the repo and apply the task safely. Follow existing patterns, preserve architecture, and explain your reasoning.\ncopy";
  const copyButton = new MockElement("copyBtn", "copy-btn");

  const document = {
    body: ensureElement("body"),
    addEventListener(type: string, listener: (event?: unknown) => void) {
      const current = windowListeners.get(`document:${type}`) ?? [];
      current.push(listener);
      windowListeners.set(`document:${type}`, current);
    },
    removeEventListener(type: string, listener: (event?: unknown) => void) {
      const current = windowListeners.get(`document:${type}`);
      if (!current) return;
      windowListeners.set(
        `document:${type}`,
        current.filter((candidate) => candidate !== listener)
      );
    },
    createElement(tagName: string) {
      return new MockElement(tagName);
    },
    createTextNode(text: string) {
      const node = new MockElement("text");
      node.textContent = text;
      return node;
    },
    getElementById(id: string) {
      return ensureElement(id);
    },
    querySelector(selector?: string) {
      if (selector === ".prompt-box") {
        return promptBox;
      }
      if (selector === ".copy-btn") {
        return copyButton;
      }
      if (selector === '[title="Copy cd command"]') {
        return ensureElement("copyCdCommandBtn");
      }
      const roleSelector = selector?.match(/^\[data-role="([^"]+)"\]$/);
      if (roleSelector) {
        return (
          roleButtons.find((button) => button.dataset.role === roleSelector[1]) ??
          new MockElement("query")
        );
      }
      return new MockElement("query");
    },
    querySelectorAll(selector: string) {
      if (selector === ".role-btn") {
        return roleButtons;
      }
      return [];
    },
  };

  const localStorageStore = new Map<string, string>(Object.entries(initialLocalStorage));
  const windowListeners = new Map<string, Array<(event?: unknown) => void>>();
  const context: UiContextBase = {
    document,
    localStorage: {
      getItem(key: string) {
        return localStorageStore.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        localStorageStore.set(key, value);
      },
      removeItem(key: string) {
        localStorageStore.delete(key);
      },
    },
    navigator: {
      clipboard: {
        writeText() {
          return Promise.resolve();
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: vi.fn(),
    EventSource: MockEventSource,
    window: {
      location: { href: "" },
      showDirectoryPicker: vi.fn(),
      parent: {
        postMessage() {
          // no-op
        },
      },
      top: null,
      currentUser: { id: "user_test_123" },
      addEventListener(type: string, listener: (event?: unknown) => void) {
        const current = windowListeners.get(type) ?? [];
        current.push(listener);
        windowListeners.set(type, current);
      },
      removeEventListener(type: string, listener: (event?: unknown) => void) {
        const current = windowListeners.get(type);
        if (!current) return;
        windowListeners.set(
          type,
          current.filter((candidate) => candidate !== listener)
        );
      },
    },
    Math,
    Date,
    performance: {
      now() {
        return Date.now();
      },
      memory: undefined,
    },
    encodeURIComponent,
    refreshBillingSummary: async () => {},
  };
  (context as UiContextBase & { window: UiContext["window"] }).window.showDirectoryPicker =
    vi.fn();
  (context as UiContextBase & { window: UiContext["window"] }).window = Object.assign(
    context,
    context.window
  );

  MockEventSource.instances = [];
  vm.runInNewContext(appScript, context as vm.Context);
  return {
    context: context as UiContext,
    elements: { get: ensureElement },
    localStorageStore,
    roleButtons: {
      developer: developerRoleButton,
      testEngineer: testEngineerRoleButton,
      dataAnalyst: dataAnalystRoleButton,
    },
  };
}

describe("UI complexity badge", () => {
  it("shows complexity badge when complexity is present", () => {
    const { context, elements } = buildUiHarness();
    context.showDecision({
      decision: { mode: "safe_to_apply" },
      confidence: { score: 88 },
      risk: { score: 0, breakdown: {} },
      frameworkBadge: "playwright_ts / typescript",
      complexity: "data_driven",
    });

    const badge = elements.get("complexityBadge");
    expect(badge.textContent).toBe("Data Driven");
    expect(badge.classList.contains("hidden")).toBe(false);
    expect(badge.className).toContain("data_driven");
  });

  it("hides and clears complexity badge on reset", () => {
    const { context, elements } = buildUiHarness();
    context.showDecision({
      decision: { mode: "safe_to_apply" },
      confidence: { score: 88 },
      risk: { score: 0, breakdown: {} },
      complexity: "negative",
    });

    context.resetUI();

    const badge = elements.get("complexityBadge");
    expect(badge.textContent).toBe("");
    expect(badge.classList.contains("hidden")).toBe(true);
  });

  it("remains stable when complexity is absent", () => {
    const { context, elements } = buildUiHarness();
    context.showDecision({
      decision: { mode: "preview_only" },
      confidence: { score: 60 },
      risk: { score: 0, breakdown: {} },
      frameworkBadge: "pytest / python",
    });

    const badge = elements.get("complexityBadge");
    expect(badge.textContent).toBe("");
    expect(badge.classList.contains("hidden")).toBe(true);
  });
});

describe("UI repo folder picker", () => {
  it("renders the folder picker button", () => {
    const { elements } = buildUiHarness();
    expect(elements.get("folderPickerBtn")).toBeTruthy();
  });

  it("shows selected folder name when showDirectoryPicker is available", async () => {
    const { context, elements } = buildUiHarness();
    context.window.showDirectoryPicker = vi
      .fn()
      .mockResolvedValue({ name: "zone-flyway-test" });

    await context.selectRepoFolder();

    expect(elements.get("repoSelectionBox").classList.contains("hidden")).toBe(false);
    expect(elements.get("repoSelectionLabel").textContent).toContain("zone-flyway-test");
  });

  it("uses the fallback directory input when showDirectoryPicker is unavailable", async () => {
    const { context, elements } = buildUiHarness();
    context.window.showDirectoryPicker = undefined;
    const fallback = elements.get("folderPickerFallback");
    fallback.files = [
      {
        name: "index.html",
        webkitRelativePath: "zone-ui/src/index.html",
      },
    ];

    await context.selectRepoFolder();
    context.handleFolderFallbackChange(fallback);

    expect(fallback.clicked).toBe(true);
    expect(elements.get("repoSelectionLabel").textContent).toContain("zone-ui");
  });

  it("keeps manual repo path fallback working for execute", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = queueDeveloperAsyncRun(
      vi.fn(),
      developerPatchResponse({
        patchPreview: "Summary: Fix button spacing",
        applyPatches: [],
      })
    );

    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix button spacing";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(context.fetch).toHaveBeenCalledWith(
      "/api/patch/jobs",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("reset clears and hides the selected folder state", async () => {
    const { context, elements } = buildUiHarness();
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue({ name: "zone-app" });

    await context.selectRepoFolder();
    context.resetUI();

    expect(elements.get("repoSelectionBox").classList.contains("hidden")).toBe(true);
    expect(elements.get("repoSelectionLabel").textContent).toBe("");
  });

  it("shows a clear validation message when no repo path is provided", async () => {
    const { context, elements } = buildUiHarness();
    elements.get("task").value = "polish spacing";

    await context.executeDryRun();

    expect(elements.get("errorBox").textContent).toContain("Task and repo path are required.");
  });

  it("shows a missing session message and skips requests when no authenticated user exists", async () => {
    const { context, elements } = buildUiHarness();
    context.fetch = vi.fn();
    delete (
      context.window as UiContext["window"] & {
        currentUser?: { id: string };
      }
    ).currentUser;
    elements.get("task").value = "fix spacing";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("errorBox").textContent).toContain(
      "Please sign in to use Zone."
    );
    expect(context.fetch).not.toHaveBeenCalled();
  });

  it("uses the injected current user id when available", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    (
      context.window as UiContext["window"] & { currentUser?: { id: string } }
    ).currentUser = {
      id: "user_real_123",
    };
    context.fetch = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: { mode: "safe_to_apply" },
          confidence: { score: 82 },
          risk: { score: 0, breakdown: {} },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          patchPreview: "Summary: Fix button spacing",
          warnings: [],
          applyPatches: [],
        }),
      });

    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix button spacing";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(context.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/check-access?userId=user_real_123&billingMode=hosted"
    );
  });
});

describe("UI result summary", () => {
  it("renders a compact summary header with available metadata", () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.selectRole(roleButtons.testEngineer);

    context.showDecision({
      decision: { mode: "safe_to_apply" },
      confidence: { score: 88 },
      risk: { score: 0, breakdown: {} },
      frameworkBadge: "playwright_ts / typescript",
      complexity: "data_driven",
    });

    context.showPatch({
      ok: true,
      patchPreview: "Summary: Generated login tests",
      warnings: ["warning 1"],
      contextFiles: ["src/pages/LoginPage.tsx", "tests/login.spec.ts"],
      applyPatches: [
        {
          filePath: "tests/login.spec.ts",
          fullContent: "test('login', async () => {});",
        },
      ],
    });

    expect(elements.get("resultSummaryTitle").textContent).toBe("Test Engineer Result");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Status: Safe to Apply");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Files: 1");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Warnings: 1");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Framework: playwright_ts");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Complexity: Data Driven");
  });

  it("handles missing optional summary fields safely", () => {
    const { context, elements } = buildUiHarness();

    context.showDecision({
      decision: { mode: "preview_only" },
      confidence: { score: 52 },
      risk: { score: 0, breakdown: {} },
    });

    context.showPatch({
      ok: true,
      patchPreview: "Summary: Preview only",
      warnings: [],
      applyPatches: [],
    });

    expect(elements.get("resultSummaryTitle").textContent).toBe("Developer Result");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Status: Preview Only");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Warnings: 0");
    expect(elements.get("resultSummaryChips").innerHTML).not.toContain("Framework:");
    expect(elements.get("resultSummaryChips").innerHTML).not.toContain("Complexity:");
  });
});

describe("UI no-op diff detection", () => {
  it("hides apply affordances when failed tests are unrelated but total changed lines are zero", () => {
    const { context } = buildUiHarness();

    const state = context.getEffectiveDiffState({
      decisionMode: "safe_to_apply",
      verificationReason: "tests_failed_unrelated",
      patchScope: { totalChangedLines: 0 },
      fileDiffs: [
        {
          filePath: "src/example.ts",
          addedLines: 0,
          removedLines: 0,
          diff: [],
        },
      ],
    });

    expect(state.effectiveDiffsEmpty).toBe(true);
  });

  it("keeps apply affordances available when safe_to_apply has changed lines", () => {
    const { context } = buildUiHarness();

    const state = context.getEffectiveDiffState({
      decisionMode: "safe_to_apply",
      patchScope: { totalChangedLines: 5 },
      fileDiffs: [
        {
          filePath: "src/example.ts",
          addedLines: 3,
          removedLines: 2,
          diff: [
            { type: "removed", content: "export const value = 1;" },
            { type: "added", content: "export const value = 2;" },
          ],
        },
      ],
    });

    expect(state.effectiveDiffsEmpty).toBe(false);
  });

  it("preserves the no_changes_made no-op path", () => {
    const { context } = buildUiHarness();

    const state = context.getEffectiveDiffState({
      decisionMode: "preview_only",
      verificationReason: "no_changes_made",
      patchScope: { totalChangedLines: 0 },
      fileDiffs: [],
    });

    expect(state.effectiveDiffsEmpty).toBe(true);
  });
});

describe("UI cost meter cache colors", () => {
  it("maps 0%, 50%, and 89% cache-hit states to red/yellow/green classes", () => {
    const { context } = buildUiHarness();

    expect(context.cacheClass(0)).toBe("cold");
    expect(context.cacheClass(0.5)).toBe("warm");
    expect(context.cacheClass(0.89)).toBe("hot");
  });
});

describe("UI cost meter subagent rollup (Bug E)", () => {
  function newMeter(context: { ensureCostMeterState: (rid: string) => unknown }): {
    bySource: Record<string, Record<string, number | boolean>>;
    cumulative: number;
    totalTokens: number;
    mainAgentTokens: number;
    subagentTokens: number;
    totalCacheRead: number;
    totalInputUncached: number;
  } {
    const m = context.ensureCostMeterState("run-1") as any;
    // Tests construct fresh in-meter source snapshots manually so they don't
    // depend on event-handler side effects (DOM, state.runsByThread).
    m.bySource = {};
    return m;
  }

  it("returns parent-only totals when no subagents", () => {
    const { context } = buildUiHarness() as any;
    const meter = newMeter(context);
    meter.bySource["parent"] = { cumulative: 0.20, totalTokens: 200_000 };
    const agg = context.aggregateCostMeter(meter);
    expect(agg.cumulative).toBeCloseTo(0.20, 4);
    expect(agg.totalTokens).toBe(200_000);
    expect(agg.liveSubagentCount).toBe(0);
  });

  it("aggregates parent + one live subagent", () => {
    const { context } = buildUiHarness() as any;
    const meter = newMeter(context);
    meter.bySource["parent"] = { cumulative: 0.20, totalTokens: 200_000 };
    meter.bySource["subagent:sub-1"] = { cumulative: 0.10, totalTokens: 115_000 };
    const agg = context.aggregateCostMeter(meter);
    expect(agg.cumulative).toBeCloseTo(0.30, 4);
    expect(agg.totalTokens).toBe(315_000);
    expect(agg.subagentTokens).toBe(115_000);
    expect(agg.liveSubagentCount).toBe(1);
  });

  it("aggregates parent + three live subagents", () => {
    const { context } = buildUiHarness() as any;
    const meter = newMeter(context);
    meter.bySource["parent"] = { cumulative: 0.20, totalTokens: 200_000 };
    meter.bySource["subagent:a"] = { cumulative: 0.05, totalTokens: 50_000 };
    meter.bySource["subagent:b"] = { cumulative: 0.04, totalTokens: 40_000 };
    meter.bySource["subagent:c"] = { cumulative: 0.06, totalTokens: 60_000 };
    const agg = context.aggregateCostMeter(meter);
    expect(agg.cumulative).toBeCloseTo(0.35, 4);
    expect(agg.totalTokens).toBe(350_000);
    expect(agg.liveSubagentCount).toBe(3);
  });

  it("excludes done subagents (their cost is folded into parent.cumulative)", () => {
    const { context } = buildUiHarness() as any;
    const meter = newMeter(context);
    meter.bySource["parent"] = { cumulative: 0.25, totalTokens: 250_000 }; // includes done sub
    meter.bySource["subagent:done-1"] = { cumulative: 0.05, totalTokens: 50_000, done: true };
    meter.bySource["subagent:live-1"] = { cumulative: 0.07, totalTokens: 70_000 };
    const agg = context.aggregateCostMeter(meter);
    // 0.25 (parent already includes done sub) + 0.07 (live) = 0.32 — no double-count
    expect(agg.cumulative).toBeCloseTo(0.32, 4);
    expect(agg.totalTokens).toBe(320_000);
    expect(agg.liveSubagentCount).toBe(1);
  });

  it("markSubagentCostSourceDone flips a live source to done", () => {
    const { context } = buildUiHarness() as any;
    const meter = newMeter(context);
    meter.bySource["parent"] = { cumulative: 0.20, totalTokens: 200_000 };
    meter.bySource["subagent:x"] = { cumulative: 0.10, totalTokens: 100_000 };
    expect(context.aggregateCostMeter(meter).cumulative).toBeCloseTo(0.30, 4);
    context.markSubagentCostSourceDone(meter, "x");
    expect(meter.bySource["subagent:x"].done).toBe(true);
    expect(context.aggregateCostMeter(meter).cumulative).toBeCloseTo(0.20, 4);
  });

  it("sums cache stats across all sources (parent + live subagents)", () => {
    const { context } = buildUiHarness() as any;
    const meter = newMeter(context);
    meter.bySource["parent"] = {
      cumulative: 0.20,
      totalTokens: 200_000,
      totalCacheRead: 80_000,
      totalInputUncached: 20_000,
    };
    meter.bySource["subagent:s"] = {
      cumulative: 0.05,
      totalTokens: 50_000,
      totalCacheRead: 30_000,
      totalInputUncached: 5_000,
    };
    const agg = context.aggregateCostMeter(meter);
    expect(agg.totalCacheRead).toBe(110_000);
    expect(agg.totalInputUncached).toBe(25_000);
  });

  it("does not pollute another runId's meter when subagentId is set", () => {
    const { context } = buildUiHarness() as any;
    // Two independent parent runs with their own meters.
    const meterA = context.ensureCostMeterState("run-A") as any;
    const meterB = context.ensureCostMeterState("run-B") as any;
    meterA.bySource = { parent: { cumulative: 0.10, totalTokens: 100_000 } };
    meterB.bySource = { parent: { cumulative: 0.20, totalTokens: 200_000 } };
    // Subagent event addressed to run-A only.
    meterA.bySource["subagent:s1"] = { cumulative: 0.05, totalTokens: 50_000 };
    expect(context.aggregateCostMeter(meterA).cumulative).toBeCloseTo(0.15, 4);
    expect(context.aggregateCostMeter(meterB).cumulative).toBeCloseTo(0.20, 4);
  });

  it("getCostSourceKey returns 'parent' when no subagentId, 'subagent:<id>' when present", () => {
    const { context } = buildUiHarness() as any;
    expect(context.getCostSourceKey({ cumulativeCost: 0.1 })).toBe("parent");
    expect(context.getCostSourceKey({ subagentId: "abc" })).toBe("subagent:abc");
    expect(context.getCostSourceKey({ subagentId: "" })).toBe("parent");
  });

  it("ensureCostMeterSource creates a default slot once and reuses it", () => {
    const { context } = buildUiHarness() as any;
    const meter = { bySource: {} } as any;
    const first = context.ensureCostMeterSource(meter, "subagent:x");
    first.cumulative = 0.12;
    const second = context.ensureCostMeterSource(meter, "subagent:x");
    expect(second).toBe(first);
    expect(second.cumulative).toBeCloseTo(0.12, 4);
  });
});

describe("UI todo sidebar", () => {
  it("renders mixed todo statuses with completed plus skipped counter", () => {
    const { context, elements } = buildUiHarness();

    context.activateThread("thread-1");
    context.setRun("thread-1", { runId: "run-1" });
    context.setTodosForRun("run-1", [
      { id: "todo-0", text: "Read files", status: "completed" },
      { id: "todo-1", text: "Patch UI", description: "Render sidebar", status: "in_progress" },
      { id: "todo-2", text: "Skip deploy", filesLikely: ["src/ui/index.html"], status: "skipped" },
    ]);

    const sidebar = elements.get("zoneTodoSidebar");
    expect(sidebar.dataset.state).toBe("visible");
    expect(sidebar.textContent).toContain("2/3");
    expect(sidebar.textContent).toContain("Read files");
    expect(sidebar.textContent).toContain("Render sidebar");
    expect(sidebar.textContent).toContain("src/ui/index.html");
  });

  it("shows todos for the active thread run and hides for a new run without todos", () => {
    const { context, elements } = buildUiHarness();

    context.activateThread("thread-1");
    context.setRun("thread-1", { runId: "run-1" });
    context.setTodosForRun("run-1", [
      { id: "todo-0", text: "First thread", status: "completed" },
    ]);
    expect(elements.get("zoneTodoSidebar").textContent).toContain("First thread");

    context.setRun("thread-1", { runId: "run-2" });
    expect(elements.get("zoneTodoSidebar").dataset.state).toBe("hidden");

    context.setTodosForRun("run-2", [
      { id: "todo-0", text: "Second run", status: "pending" },
    ]);
    expect(elements.get("zoneTodoSidebar").textContent).toContain("Second run");
    expect(elements.get("zoneTodoSidebar").textContent).not.toContain("First thread");
  });
});

describe("UI data analyst flow", () => {
  it("calls the data analyst endpoint when that role is selected", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        dialect: "postgresql",
        migrationFormat: "flyway",
        confidence: 91,
        summary: "Creates orders table",
        warnings: [],
        applyPatches: [
          {
            filePath: "db/migration/V3__orders.sql",
            fullContent: "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY);",
          },
        ],
        preview: "=== DATA ANALYST PREVIEW ===\nSummary: Creates orders table",
      }),
    });
    context.fetch = fetchMock;
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo/zone-flyway-test";

    await context.execute();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/data-analyst",
      expect.objectContaining({
        method: "POST",
      })
    );
  });

  it("renders returned SQL preview and warnings for data analyst results", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        dialect: "postgresql",
        migrationFormat: "flyway",
        confidence: 91,
        summary: "Creates orders table",
        warnings: ["[SQL_MISSING_PRIMARY_KEY] Review composite key strategy"],
        applyPatches: [
          {
            filePath: "db/migration/V3__orders.sql",
            fullContent: "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY);",
          },
        ],
        preview: "=== DATA ANALYST PREVIEW ===\nSummary: Creates orders table",
      }),
    });
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo/zone-flyway-test";

    await context.execute();

    expect(elements.get("frameworkBadge").textContent).toBe("🔍 postgresql / flyway");
    expect(elements.get("patchSummary").textContent).toBe("Creates orders table");
    expect(String(elements.get("filesVal").textContent)).toBe("1");
    expect(elements.get("warningsList").classList.contains("hidden")).toBe(false);
    expect(elements.get("warningsList").innerHTML).toContain("SQL_MISSING_PRIMARY_KEY");
    expect(elements.get("patchSection").classList.contains("hidden")).toBe(false);
  });

  it("reset clears data analyst result state cleanly", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        dialect: "postgresql",
        migrationFormat: "flyway",
        confidence: 91,
        summary: "Creates orders table",
        warnings: ["warning"],
        applyPatches: [
          {
            filePath: "db/migration/V3__orders.sql",
            fullContent: "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY);",
          },
        ],
        preview: "=== DATA ANALYST PREVIEW ===\nSummary: Creates orders table",
      }),
    });
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo/zone-flyway-test";

    await context.execute();
    context.resetUI();

    expect(elements.get("decisionSection").classList.contains("hidden")).toBe(true);
    expect(elements.get("patchSection").classList.contains("hidden")).toBe(true);
    expect(elements.get("warningsList").classList.contains("hidden")).toBe(true);
    expect(elements.get("repoPath").value).toBe("");
    expect(elements.get("task").value).toBe("");
  });

  it("remains stable when optional data analyst metadata is missing", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        confidence: 65,
        summary: "Creates orders table",
        warnings: [],
        applyPatches: [
          {
            filePath: "sql/orders.sql",
            fullContent: "CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY);",
          },
        ],
        preview: "=== DATA ANALYST PREVIEW ===\nSummary: Creates orders table",
      }),
    });
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo/zone-flyway-test";

    await context.execute();

    expect(elements.get("frameworkBadge").classList.contains("hidden")).toBe(true);
    expect(elements.get("patchSection").classList.contains("hidden")).toBe(false);
    expect(elements.get("patchSummary").textContent).toBe("Creates orders table");
  });
});

describe("UI developer context files", () => {
  it("shows context files for developer runs when available", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = queueDeveloperAsyncRun(
      vi.fn(),
      developerPatchResponse({
        patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Fix login flow",
        contextFiles: [
          "src/components/LoginForm.tsx",
          "server/routes/auth.ts",
        ],
        applyPatches: [
          {
            filePath: "src/components/LoginForm.tsx",
            fullContent: "export function LoginForm() {}",
          },
        ],
      })
    );

    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("contextFilesBox").classList.contains("hidden")).toBe(false);
    expect(elements.get("contextFilesList").innerHTML).toContain("src/components/LoginForm.tsx");
    expect(elements.get("contextFilesList").innerHTML).toContain("server/routes/auth.ts");
  });

  it("hides context files when they are absent", () => {
    const { context, elements } = buildUiHarness();

    context.showPatch({
      ok: true,
      patchPreview: "Summary: Preview",
      warnings: [],
      applyPatches: [],
    });

    expect(elements.get("contextFilesBox").classList.contains("hidden")).toBe(true);
    expect(elements.get("contextFilesList").innerHTML).toBe("");
  });

  it("reset clears developer context files", () => {
    const { context, elements } = buildUiHarness();

    context.showPatch({
      ok: true,
      patchPreview: "Summary: Preview",
      warnings: [],
      contextFiles: ["src/components/LoginForm.tsx"],
      applyPatches: [],
    });

    context.resetUI();

    expect(elements.get("contextFilesBox").classList.contains("hidden")).toBe(true);
    expect(elements.get("contextFilesList").innerHTML).toBe("");
  });
});

describe("UI recent runs", () => {
  it("adds a recent run after a successful run", async () => {
    const { context, elements, roleButtons, localStorageStore } = buildUiHarness();
    context.fetch = queueDeveloperAsyncRun(
      vi.fn(),
      developerPatchResponse({
        patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Fix login flow",
        applyPatches: [],
      })
    );

    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("recentRunsEmpty").classList.contains("hidden")).toBe(true);
    expect(elements.get("recentRunsList").innerHTML).toContain("fix login flow");
    expect(elements.get("recentRunsList").innerHTML).toContain("success");
    expect(localStorageStore.get("zone_recent_runs")).toContain("fix login flow");
  });

  it("adds a recent run after a failed run", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockRejectedValue(new Error("Network failure"));
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("recentRunsList").innerHTML).toContain("error");
    expect(elements.get("recentRunsList").innerHTML).toContain("fix login flow");
  });

  it("renders recent runs in reverse chronological order", () => {
    const seededRuns = JSON.stringify([
      { task: "older run", role: "developer", repoPath: "C:/old", status: "success", timestamp: 1 },
      { task: "newer run", role: "test_engineer", repoPath: "C:/new", status: "error", timestamp: 2 },
    ]);
    const { elements } = buildUiHarness({
      zone_recent_runs: seededRuns,
    });

    const html = elements.get("recentRunsList").innerHTML;
    expect(html.indexOf("newer run")).toBeLessThan(html.indexOf("older run"));
  });

  it("caps recent runs to the maximum size", () => {
    const { context } = buildUiHarness();

    for (let i = 0; i < 8; i += 1) {
      context.addRecentRun({
        task: `task ${i}`,
        role: "developer",
        repoPath: `C:/repo/${i}`,
        status: "success",
        timestamp: i,
      });
    }

    const saved = JSON.parse(context.localStorage.getItem("zone_recent_runs") ?? "[]");
    expect(saved).toHaveLength(6);
    expect(saved[0].task).toBe("task 7");
    expect(saved[5].task).toBe("task 2");
  });

  it("reset does not clear recent runs", () => {
    const { context, elements } = buildUiHarness();
    context.addRecentRun({
      task: "fix login flow",
      role: "developer",
      repoPath: "C:/repo",
      status: "success",
      timestamp: Date.now(),
    });

    context.resetUI();

    expect(elements.get("recentRunsList").innerHTML).toContain("fix login flow");
  });

  it("stays stable when recent runs are empty", () => {
    const { elements } = buildUiHarness();

    expect(elements.get("recentRunsEmpty").classList.contains("hidden")).toBe(false);
    expect(elements.get("recentRunsList").classList.contains("hidden")).toBe(true);
  });

  it("loads recent runs from localStorage and can refill the form", () => {
    const seededRuns = JSON.stringify([
      {
        task: "create orders table",
        role: "data_analyst",
        repoPath: "C:/repo/zone-flyway-test",
        status: "success",
        timestamp: Date.now(),
      },
    ]);
    const { context, elements, roleButtons } = buildUiHarness({
      zone_recent_runs: seededRuns,
    });

    context.loadRecentRun(0);

    expect(elements.get("task").value).toBe("create orders table");
    expect(elements.get("repoPath").value).toBe("C:/repo/zone-flyway-test");
    expect(roleButtons.dataAnalyst.classList.contains("active")).toBe(true);
  });
});

describe("UI execute pre-flight access", () => {
  it("stops immediately on unauthorized pre-flight response", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        deniedResponse(401, {
          ok: false,
          reason: "unauthorized",
          message: "Missing user session. Please open Zone from your dashboard.",
        })
      );
    context.fetch = fetchMock;
    context.selectRole(roleButtons.testEngineer);
    elements.get("task").value = "add login test";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/check-access?userId=")
    );
    expect(elements.get("progressBox").classList.contains("hidden")).toBe(true);
    expect(elements.get("progressText").textContent).toBe("");
    expect(elements.get("execBtn").disabled).toBe(false);
    expect(elements.get("errorBox").textContent).toContain(
      "Missing user session. Please open Zone from your dashboard."
    );
  });

  it("stops immediately on no_free_runs pre-flight response", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        deniedResponse(402, {
          ok: false,
          reason: "no_free_runs",
          message: "You've used all your free runs. Upgrade to Pro.",
          upgradeUrl: "https://zonecli.dev/#pricing",
        })
      );
    context.fetch = fetchMock;
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/check-access?userId=")
    );
    expect(elements.get("progressBox").classList.contains("hidden")).toBe(true);
    expect(elements.get("progressText").textContent).toBe("");
    expect(elements.get("execBtn").disabled).toBe(true);
    expect(elements.get("errorBox").innerHTML).toContain("Upgrade to Pro");
    expect(elements.get("errorBox").innerHTML).toContain(
      "https://zonecli.dev/#pricing"
    );
  });

  it("uses the default pricing URL when no_free_runs does not include upgradeUrl", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        deniedResponse(402, {
          ok: false,
          reason: "no_free_runs",
          message: "You've used all your free runs. Upgrade to Pro.",
        })
      );
    context.selectRole(roleButtons.testEngineer);
    elements.get("task").value = "add login test";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("errorBox").innerHTML).toContain(
      'href="https://zonecli.dev/#pricing"'
    );
  });

  it("proceeds normally when pre-flight access is allowed", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce(
        okResponse({
          ok: true,
          framework: "playwright_ts",
          language: "typescript",
          confidence: 82,
          summary: "Generated test",
          warnings: [],
          complexity: "single_scenario",
          applyPatches: [],
          preview: "preview",
        })
      );
    context.fetch = fetchMock;
    context.selectRole(roleButtons.testEngineer);
    elements.get("task").value = "add login test";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/api/check-access?userId=")
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/test-engineer",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("requires a selected folder in hosted mode and maps the hosted repo access error", () => {
    const { context, elements } = buildUiHarness();
    (
      context.window as typeof context.window & {
        __ZONE_PUBLIC_CONFIG__?: { zoneApiBaseUrl: string };
      }
    ).__ZONE_PUBLIC_CONFIG__ = {
      zoneApiBaseUrl: "https://api.zonecli.dev",
    };

    (context as unknown as { renderRepoSelection(): void }).renderRepoSelection();

    expect(elements.get("execBtn").disabled).toBe(true);
    expect(elements.get("dryRunBtn").disabled).toBe(true);
    expect(elements.get("repoSelectionBox").classList.contains("hidden")).toBe(false);
    expect(elements.get("repoSelectionMeta").textContent).toContain(
      "Select your project folder to get started"
    );

    (context as unknown as { showError(message: string): void }).showError(
      "repo_not_accessible_in_hosted_mode"
    );
    expect(elements.get("errorBox").textContent).toBe("");
  });

  it("attaches hostedContext to /api/test-engineer when a hosted folder is selected", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    const packageJson = await rootHandle.getFileHandle("package.json", { create: true });
    packageJson.content = JSON.stringify({ devDependencies: { "@playwright/test": "^1.0.0" } });
    const playwrightConfig = await rootHandle.getFileHandle("playwright.config.ts", {
      create: true,
    });
    playwrightConfig.content = "import { defineConfig } from '@playwright/test'; export default defineConfig({});";
    const testsDir = await rootHandle.getDirectoryHandle("tests", { create: true });
    const testFile = await testsDir.getFileHandle("login.spec.ts", { create: true });
    testFile.content = "import { test, expect } from '@playwright/test'; test('login', async () => {});";
    (
      context.window as typeof context.window & {
        __ZONE_PUBLIC_CONFIG__?: { zoneApiBaseUrl: string };
      }
    ).__ZONE_PUBLIC_CONFIG__ = {
      zoneApiBaseUrl: "https://api.zonecli.dev",
    };
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce(
        okResponse({
          ok: true,
          framework: "playwright_ts",
          language: "typescript",
          confidence: 82,
          summary: "Generated test",
          warnings: [],
          complexity: "single_scenario",
          applyPatches: [],
          preview: "preview",
        })
      );
    context.fetch = fetchMock;

    await context.selectRepoFolder();
    context.selectRole(roleButtons.testEngineer);
    elements.get("task").value = "add login test";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    const requestInit = fetchMock.mock.calls[1]?.[1] as { body?: string };
    const body = JSON.parse(requestInit.body || "{}");
    expect(body.hostedContext).toBeTruthy();
    expect(body.hostedContext.availableFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "package.json" }),
        expect.objectContaining({ path: "playwright.config.ts" }),
        expect.objectContaining({ path: "tests/login.spec.ts" }),
      ])
    );
    expect(body.hostedContext.existingTestContents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tests/login.spec.ts" }),
      ])
    );
  });

  it("attaches hostedContext to /api/data-analyst when a hosted folder is selected", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    const dbDir = await rootHandle.getDirectoryHandle("db", { create: true });
    const migrationDir = await dbDir.getDirectoryHandle("migration", { create: true });
    const sqlFile = await migrationDir.getFileHandle("V1__users.sql", { create: true });
    sqlFile.content = "CREATE TABLE users(id SERIAL PRIMARY KEY);";
    (
      context.window as typeof context.window & {
        __ZONE_PUBLIC_CONFIG__?: { zoneApiBaseUrl: string };
      }
    ).__ZONE_PUBLIC_CONFIG__ = {
      zoneApiBaseUrl: "https://api.zonecli.dev",
    };
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce(
        okResponse({
          ok: true,
          dialect: "postgresql",
          migrationFormat: "flyway",
          confidence: 90,
          summary: "Creates users table",
          warnings: [],
          applyPatches: [],
          preview: "preview",
        })
      );
    context.fetch = fetchMock;

    await context.selectRepoFolder();
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create users table";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    const requestInit = fetchMock.mock.calls[1]?.[1] as { body?: string };
    const body = JSON.parse(requestInit.body || "{}");
    expect(body.hostedContext).toBeTruthy();
    expect(body.hostedContext.availableFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "db/migration/V1__users.sql" }),
      ])
    );
    expect(body.hostedContext.schema).toEqual(
      expect.objectContaining({ migrationFormat: "flyway" })
    );
    expect(body.hostedContext.existingSqlContents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "db/migration/V1__users.sql" }),
      ])
    );
  });
});

describe("UI billing summary", () => {
  it("renders plan and remaining runs from the billing summary endpoint", async () => {
    const { context, elements } = buildUiHarness();
    context.fetch = vi.fn().mockResolvedValueOnce(
      okResponse({
        ok: true,
        plan: "Pro",
        credits: 18,
        subscriptionStatus: "pro",
      })
    );

    await context.refreshBillingSummary();

    expect(elements.get("billingSummaryBox").classList.contains("hidden")).toBe(false);
    expect(elements.get("billingSummaryLabel").textContent).toBe(
      "⚡ Pro 18 runs remaining this month"
    );
    expect(elements.get("billingSummaryMeta").textContent).toBe(
      "250 Hosted Runs + Unlimited BYOK / month"
    );
  });

  it("shows the upgrade CTA immediately when billing summary resolves to free with zero runs", async () => {
    const { context, elements } = buildUiHarness();
    context.fetch = vi.fn().mockResolvedValueOnce(
      okResponse({
        ok: true,
        plan: "Free",
        credits: 0,
        upgradeUrl: "https://zonecli.dev/#pricing",
      })
    );

    await context.refreshBillingSummary();

    expect(elements.get("execBtn").disabled).toBe(true);
    expect(elements.get("errorBox").innerHTML).toContain("Upgrade to Pro");
    expect(elements.get("errorBox").innerHTML).toContain(
      'href="https://zonecli.dev/#pricing"'
    );
  });
});

describe("UI patch preview", () => {
  it("renders grouped patch preview by file", () => {
    const { context, elements } = buildUiHarness();

    context.showPatch({
      ok: true,
      patchPreview: "Summary: Preview",
      warnings: [],
      applyPatches: [
        {
          filePath: "db/migration/V3__orders.sql",
          fullContent: "CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY);",
        },
        {
          filePath: "src/test/resources/features/login.feature",
          fullContent: "Feature: Login",
        },
      ],
    });

    expect(elements.get("fileList").innerHTML).toContain("<details");
    expect(elements.get("fileList").innerHTML).toContain("db/migration/V3__orders.sql");
    expect(elements.get("fileList").innerHTML).toContain("src/test/resources/features/login.feature");
  });

  it("renders collapsible preview content with the first file expanded", () => {
    const { context, elements } = buildUiHarness();

    context.showPatch({
      ok: true,
      patchPreview: "Summary: Preview",
      warnings: [],
      applyPatches: [
        {
          filePath: "tests/login.spec.ts",
          fullContent: "await page.goto('/login');\nexpect(true).toBe(true);",
        },
      ],
    });

    expect(elements.get("fileList").innerHTML).toContain("<pre>");
    expect(elements.get("fileList").innerHTML).toContain("await page.goto(&#39;/login&#39;);");
    expect(elements.get("fileList").innerHTML).toContain("<details class=\"file-card file-toggle\" open>");
  });

  it("remains stable when file metadata is partially missing", () => {
    const { context, elements } = buildUiHarness();

    context.showPatch({
      ok: true,
      patchPreview: "Summary: Preview",
      warnings: [],
      applyPatches: [
        {
          filePath: "",
          fullContent: "SELECT 1;",
        },
      ],
    });

    expect(elements.get("fileList").innerHTML).toContain("generated_file_1");
    expect(elements.get("fileList").innerHTML).toContain("SELECT 1;");
  });

  it("does not let a later log-only noop patch overwrite an existing real patch result", () => {
    const { context, elements } = buildUiHarness();

    context.showPatch({
      ok: true,
      patchPreview: "Summary: Real patch",
      warnings: [],
      applyPatches: [
        {
          filePath: "src/features/login.ts",
          fullContent: "export const login = true;",
        },
      ],
    });

    expect(String(elements.get("filesVal").textContent)).toBe("1");

    context.showPatch({
      ok: true,
      reason: "log_only_noop",
      patchPreview: "[LOG_ONLY] noop",
      warnings: ["[LOG_ONLY] noop"],
      applyPatches: [],
      fileDiffs: [],
    });

    expect(String(elements.get("filesVal").textContent)).toBe("1");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Files: 1");
  });
});

describe("UI folder-handle apply", () => {
  it("keeps Apply disabled with an exact blocking reason until both a patch and folder handle exist", async () => {
    const { context, elements, roleButtons } = buildUiHarness();

    expect(elements.get("applyBtn").disabled).toBe(true);
    expect(elements.get("applyStatusBox").textContent).toContain("Run Execute first");

    context.fetch = queueDeveloperAsyncRun(vi.fn());
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("applyBtn").disabled).toBe(false);
    expect(elements.get("applyBtn").className).toContain("is-enabled");
    expect(elements.get("applyBtn").getAttribute("aria-disabled")).toBe("false");
    expect(elements.get("decisionBadge").className).toContain("safe");
    expect(elements.get("applyStatusBox").textContent).toContain("Ready to apply to: C:/repo");
    expect(elements.get("applyStatusBox").textContent).not.toContain("blocked");
  });

  it("keeps non-blocking warnings from blocking an otherwise safe result", () => {
    const { context, elements } = buildUiHarness();

    context.showDecision({
      decision: { mode: "safe_to_apply" },
      confidence: { score: 95 },
      risk: { score: 0, breakdown: {} },
      frameworkBadge: "playwright_ts / typescript",
    });
    context.showPatch({
      ok: true,
      patchPreview: "Summary: Generated login tests",
      warnings: ["Selector may be brittle but still repository-native"],
      applyPatches: [
        {
          filePath: "tests/login.spec.ts",
          fullContent: "test('login', async () => {});",
        },
      ],
    });

    expect(elements.get("decisionBadge").className).toContain("safe");
    expect(elements.get("confVal").textContent).toBe("95");
    expect(elements.get("resultSummaryChips").innerHTML).toContain("Warnings: 1");
    expect(elements.get("applyBtn").disabled).toBe(false);
    expect(elements.get("applyStatusBox").textContent).toContain("Run Execute first.");
  });

  it("keeps validation-blocked preview visible but disables Apply with an explicit blocked message", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: false,
        validationBlocked: true,
        decisionMode: "blocked",
        framework: "playwright_ts",
        language: "typescript",
        confidence: 35,
        summary: "Generated login test",
        warnings: ["[URL_ASSERTION] Repository route evidence was insufficient"],
        applyPatches: [
          {
            filePath: "tests/login.spec.ts",
            fullContent: "test('login', async () => {});",
          },
        ],
        preview: "=== TEST ENGINEER PREVIEW ===\nSummary: Generated login test\n\nFiles to create:\n- tests/login.spec.ts",
        reason: "Output validation blocked: Generated Playwright URL assertion uses an arbitrary regex pattern instead of a repository-evidenced route.",
      }),
    });

    await context.selectRepoFolder();
    context.selectRole(roleButtons.testEngineer);
    elements.get("task").value = "add a negative login test";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("patchSection").classList.contains("hidden")).toBe(false);
    expect(elements.get("decisionBadge").className).toContain("blocked");
    expect(elements.get("confVal").textContent).toBe("35");
    expect(elements.get("patchSummary").textContent).toContain("Preview available for debugging only. Apply is blocked by output validation.");
    expect(elements.get("applyBtn").disabled).toBe(true);
    expect(elements.get("applyStatusBox").textContent).toContain("Blocked by output validation.");
    expect(elements.get("applyStatusBox").textContent).not.toContain("Ready to apply");
    expect(elements.get("errorBox").textContent).toContain("Output validation blocked");
  });

  it("starting a new run clears stale apply success and restore state before showing a blocked preview", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = queueDeveloperAsyncRun(vi.fn())
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: false,
          validationBlocked: true,
          decisionMode: "blocked",
          framework: "playwright_ts",
          language: "typescript",
          confidence: 35,
          summary: "Generated login test",
          warnings: [],
          applyPatches: [
            {
              filePath: "tests/login.spec.ts",
              fullContent: "test('login', async () => {});",
            },
          ],
          preview: "=== TEST ENGINEER PREVIEW ===\nSummary: Generated login test\n\nFiles to create:\n- tests/login.spec.ts",
          reason: "Output validation blocked: Generated Playwright URL assertion uses an arbitrary regex pattern instead of a repository-evidenced route.",
        }),
      })
      .mockResolvedValueOnce(
        okResponse({ ok: true, plan: "Free", credits: 9, subscriptionStatus: "free" })
      );

    await context.selectRepoFolder();
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";
    await context.execute();
    await context.applyChanges();

    expect(elements.get("successBox").innerHTML).toContain("Applied successfully");
    expect(elements.get("restoreBtn").classList.contains("hidden")).toBe(false);

    context.selectRole(roleButtons.testEngineer);
    elements.get("task").value = "add a negative login test";
    await context.execute();

    expect(elements.get("successBox").style.display).toBe("none");
    expect(elements.get("successBox").innerHTML).toBe("");
    expect(elements.get("restoreBtn").classList.contains("hidden")).toBe(true);
    expect(elements.get("applyBtn").disabled).toBe(true);
    expect(elements.get("applyStatusBox").textContent).toContain("Blocked by output validation.");
  });

  it("writes files through the selected folder handle", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = queueDeveloperAsyncRun(vi.fn());

    await context.selectRepoFolder();
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("applyBtn").disabled).toBe(false);
    expect(elements.get("applyBtn").className).toContain("is-enabled");
    expect(elements.get("applyBtn").getAttribute("aria-disabled")).toBe("false");

    await context.applyChanges();

    expect(elements.get("applyBtn").disabled).toBe(true);
    expect(elements.get("applyBtn").className).toContain("is-disabled");
    expect(elements.get("applyStatusBox").textContent).toContain("Run Execute first.");
    const srcDir = await rootHandle.getDirectoryHandle("src");
    const featuresDir = await srcDir.getDirectoryHandle("features");
    const fileHandle = await featuresDir.getFileHandle("login.ts");
    expect(fileHandle.writable.written).toBe("export const login = true;");
    expect(elements.get("successBox").innerHTML).toContain("Applied successfully");
    expect(elements.get("successBox").innerHTML).toContain("file written");
    expect(elements.get("successBox").innerHTML).toContain(">1</strong>");
    expect(elements.get("successBox").innerHTML).toContain("src/features/login.ts");
    expect(elements.get("successBox").innerHTML).toContain("Target: zone-repo");
    expect(elements.get("successBox").innerHTML).toContain("Restore is ready for this session.");
    expect(elements.get("restoreBtn").classList.contains("hidden")).toBe(false);
  });

  it("shows a compact multi-file apply summary when multiple files are written", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = queueDeveloperAsyncRun(
      vi.fn(),
      developerPatchResponse({
        patchPreview: "Summary: Update repo files",
        applyPatches: [
          {
            filePath: "src/features/login.ts",
            fullContent: "export const login = true;",
          },
          {
            filePath: "db/migration/V1__init.sql",
            fullContent: "create table users(id int);",
          },
          {
            filePath: "tests/login.spec.ts",
            fullContent: "test('login', async () => {});",
          },
          {
            filePath: "src/ui/index.html",
            fullContent: "<div>ok</div>",
          },
          {
            filePath: "README.md",
            fullContent: "# Zone",
          },
          {
            filePath: "src/api/server.ts",
            fullContent: "export const server = true;",
          },
        ],
      })
    );

    await context.selectRepoFolder();
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "update repo files";
    elements.get("repoPath").value = "C:/repo";
    await context.execute();
    await context.applyChanges();

    expect(elements.get("successBox").innerHTML).toContain("files written");
    expect(elements.get("successBox").innerHTML).toContain(">6</strong>");
    expect(elements.get("successBox").innerHTML).toContain("created");
    expect(elements.get("successBox").innerHTML).toContain("modified");
    expect(elements.get("successBox").innerHTML).toContain("src/features/login.ts");
    expect(elements.get("successBox").innerHTML).toContain("db/migration/V1__init.sql");
    expect(elements.get("successBox").innerHTML).toContain("tests/login.spec.ts");
    expect(elements.get("successBox").innerHTML).toContain("src/ui/index.html");
    expect(elements.get("successBox").innerHTML).toContain("README.md");
    expect(elements.get("successBox").innerHTML).toContain("+1 more");
    expect(elements.get("successBox").innerHTML).not.toContain("src/api/server.ts");
  });

  it("shows an error when no folder handle is available during apply", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = queueDeveloperAsyncRun(vi.fn());

    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();
    await context.applyChanges();

    expect(elements.get("errorBox").textContent).toContain("reading 'ok'");
  });

  it("keeps helper text, visual state, and disabled state aligned for Apply", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = queueDeveloperAsyncRun(vi.fn());

    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("applyBtn").disabled).toBe(false);
    expect(elements.get("applyBtn").className).toContain("is-enabled");
    expect(elements.get("applyStatusBox").textContent).toContain("Ready to apply to: C:/repo");

    await context.selectRepoFolder();

    expect(elements.get("applyBtn").disabled).toBe(false);
    expect(elements.get("applyBtn").className).toContain("is-enabled");
    expect(elements.get("applyStatusBox").textContent).toContain("Ready to apply to: zone-repo");
  });

  it("handles permission errors gracefully and reset clears the handle", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const deniedHandle = new MockDirectoryHandle("zone-repo", "denied");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(deniedHandle);
    context.fetch = queueDeveloperAsyncRun(vi.fn());

    await context.selectRepoFolder();
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();
    await context.applyChanges();
    expect(elements.get("errorBox").textContent).toContain("Write permission denied");

    context.resetUI();
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";
    context.fetch = queueDeveloperAsyncRun(vi.fn());
    await context.execute();
    await context.applyChanges();
    expect(elements.get("errorBox").textContent).toContain("reading 'ok'");
  });

  it("keeps apply summary safe when no files are written", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = queueDeveloperAsyncRun(
      vi.fn(),
      developerPatchResponse({
        applyPatches: [
          {
            filePath: "/",
            fullContent: "export const login = true;",
          },
        ],
      })
    );
    await context.selectRepoFolder();
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();
    await context.applyChanges();

    expect(elements.get("successBox").innerHTML).toContain("No files were written");
    expect(elements.get("successBox").innerHTML).toContain("Target: zone-repo");
    expect(elements.get("restoreBtn").classList.contains("hidden")).toBe(true);
  });

  it("keeps apply summary safe when no patches exist", async () => {
    const { context, elements } = buildUiHarness();
    await context.applyChanges();
    expect(elements.get("errorBox").textContent).toContain("Run Execute first.");
    expect(elements.get("successBox").innerHTML).toBe("");
  });

  it("restores original file contents after apply", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    const srcDir = await rootHandle.getDirectoryHandle("src", { create: true });
    const featuresDir = await srcDir.getDirectoryHandle("features", { create: true });
    const fileHandle = await featuresDir.getFileHandle("login.ts", { create: true });
    fileHandle.content = "export const login = false;";
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = queueDeveloperAsyncRun(vi.fn());

    await context.selectRepoFolder();
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();
    await context.applyChanges();
    expect(fileHandle.content).toBe("export const login = true;");

    await context.restorePreviousState();

    expect(fileHandle.content).toBe("export const login = false;");
    expect(elements.get("successBox").innerHTML).toContain("Restored previous state");
    expect(elements.get("restoreBtn").classList.contains("hidden")).toBe(true);
  });
});

describe("UI progress feedback", () => {
  it("developer execute uses async patch jobs and fetches the completed result", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = queueDeveloperAsyncRun(
      vi.fn(),
      developerPatchResponse({
        developerConfidence: 82,
        decisionMode: "safe_to_apply",
        developerRisk: { score: 12, breakdown: { destructive: 0, schema: 0, massScope: 0 } },
      }),
      { progressStage: "Generating file patches..." }
    );
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(context.fetch).toHaveBeenNthCalledWith(
      2,
      "/api/patch/jobs",
      expect.objectContaining({ method: "POST" })
    );
    expect(context.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/check-access?userId=user_test_123&billingMode=hosted"
    );
    expect(
      JSON.parse(String(context.fetch.mock.calls[1]?.[1]?.body ?? "{}"))
    ).toEqual(
      expect.objectContaining({
        billingMode: "hosted",
      })
    );
    expect(context.fetch).toHaveBeenNthCalledWith(3, "/api/patch/jobs/job_123");
    expect(context.fetch).toHaveBeenNthCalledWith(4, "/api/patch/jobs/job_123/result");
    expect(elements.get("decisionBadge").className).toContain("safe");
    expect(elements.get("patchSection").classList.contains("hidden")).toBe(false);
  });

  it("propagates billingMode=byok for local inference developer execution", async () => {
    const { context, elements, roleButtons } = buildUiHarness({
      zone_inference_mode: "local",
      zone_user_openai_key: "sk-user",
    });
    context.fetch = queueDeveloperAsyncRun(
      vi.fn(),
      developerPatchResponse({
        developerConfidence: 82,
        decisionMode: "safe_to_apply",
      })
    );
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(context.fetch).toHaveBeenNthCalledWith(
      1,
      "/api/check-access?userId=user_test_123&billingMode=byok"
    );
    expect(
      JSON.parse(String(context.fetch.mock.calls[1]?.[1]?.body ?? "{}"))
    ).toEqual(
      expect.objectContaining({
        billingMode: "byok",
      })
    );
  });

  it("developer progress UI reflects the polled progress stage", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    let statusCalls = 0;
    context.fetch = vi.fn().mockImplementation((input: string) => {
      if (String(input).includes("/api/check-access")) {
        return Promise.resolve(okResponse({ ok: true }));
      }
      if (String(input) === "/api/patch/jobs") {
        return Promise.resolve(okResponse({ ok: true, runId: "job_123", status: "queued" }));
      }
      if (String(input) === "/api/patch/jobs/job_123") {
        statusCalls += 1;
        if (statusCalls === 1) {
          return Promise.resolve(
            okResponse({
              ok: true,
              runId: "job_123",
              status: "running",
              progressStage: "Planning feature...",
              errorMessage: null,
            })
          );
        }
        return Promise.resolve(
          okResponse({
            ok: true,
            runId: "job_123",
            status: "completed",
            progressStage: "Ready",
            errorMessage: null,
          })
        );
      }
      if (String(input) === "/api/patch/jobs/job_123/result") {
        return Promise.resolve(okResponse(developerPatchResponse()));
      }
      if (String(input).includes("/api/billing-summary")) {
        return Promise.resolve(
          okResponse({ ok: true, plan: "Free", credits: 10, subscriptionStatus: "free" })
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    const execution = context.execute();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(elements.get("progressText").textContent).toBe("⏳ Planning feature...");

    await new Promise((resolve) => setTimeout(resolve, 1100));
    await execution;
  });

  it("reset clears active developer polling safely", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    let statusCalls = 0;
    context.fetch = vi.fn().mockImplementation((input: string) => {
      if (String(input).includes("/api/check-access")) {
        return Promise.resolve(okResponse({ ok: true }));
      }
      if (String(input) === "/api/patch/jobs") {
        return Promise.resolve(okResponse({ ok: true, runId: "job_123", status: "queued" }));
      }
      if (String(input) === "/api/patch/jobs/job_123") {
        statusCalls += 1;
        return Promise.resolve(
          okResponse({
            ok: true,
            runId: "job_123",
            status: "running",
            progressStage: "Generating file patches...",
            errorMessage: null,
          })
        );
      }
      if (String(input).includes("/api/billing-summary")) {
        return Promise.resolve(
          okResponse({ ok: true, plan: "Free", credits: 10, subscriptionStatus: "free" })
        );
      }
      throw new Error(`Unexpected fetch: ${String(input)}`);
    });
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    void context.execute();
    await new Promise((resolve) => setTimeout(resolve, 10));
    context.resetUI();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(statusCalls).toBe(1);
    expect(elements.get("progressText").textContent).toBe("");
    expect(elements.get("progressBox").classList.contains("hidden")).toBe(true);
  });

  it("older developer async runs do not overwrite newer ones", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    let run1StatusCalls = 0;
    context.fetch = vi.fn().mockImplementation((input: string, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("/api/check-access")) {
        return Promise.resolve(okResponse({ ok: true }));
      }
      if (url === "/api/patch/jobs") {
        const payload = JSON.parse(init?.body || "{}");
        return Promise.resolve(
          okResponse({
            ok: true,
            runId: payload.task === "first fix" ? "job_1" : "job_2",
            status: "queued",
          })
        );
      }
      if (url === "/api/patch/jobs/job_1") {
        run1StatusCalls += 1;
        if (run1StatusCalls === 1) {
          return Promise.resolve(
            okResponse({
              ok: true,
              runId: "job_1",
              status: "running",
              progressStage: "Planning feature...",
              errorMessage: null,
            })
          );
        }
        return Promise.resolve(
          okResponse({
            ok: true,
            runId: "job_1",
            status: "completed",
            progressStage: "Ready",
            errorMessage: null,
          })
        );
      }
      if (url === "/api/patch/jobs/job_1/result") {
        return Promise.resolve(
          okResponse(
            developerPatchResponse({
              patchPreview: "Summary: First result",
              applyPatches: [{ filePath: "src/first.ts", fullContent: "export const first = true;" }],
            })
          )
        );
      }
      if (url === "/api/patch/jobs/job_2") {
        return Promise.resolve(
          okResponse({
            ok: true,
            runId: "job_2",
            status: "completed",
            progressStage: "Ready",
            errorMessage: null,
          })
        );
      }
      if (url === "/api/patch/jobs/job_2/result") {
        return Promise.resolve(
          okResponse(
            developerPatchResponse({
              patchPreview: "Summary: Second result",
              applyPatches: [{ filePath: "src/second.ts", fullContent: "export const second = true;" }],
            })
          )
        );
      }
      if (url.includes("/api/billing-summary")) {
        return Promise.resolve(
          okResponse({ ok: true, plan: "Free", credits: 10, subscriptionStatus: "free" })
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    context.selectRole(roleButtons.developer);
    elements.get("repoPath").value = "C:/repo";

    elements.get("task").value = "first fix";
    void context.execute();
    await new Promise((resolve) => setTimeout(resolve, 10));

    elements.get("task").value = "second fix";
    await context.execute();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(elements.get("patchSummary").textContent).toContain("Second result");
    expect(elements.get("fileList").innerHTML).toContain("src/second.ts");
    expect(elements.get("fileList").innerHTML).not.toContain("src/first.ts");
  });

  it("renders progress while a run is in progress", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    let resolveFetch: ((value: {
      ok: boolean;
      json: () => Promise<unknown>;
    }) => void) | undefined;
    let callCount = 0;
    context.fetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(okResponse({ ok: true }));
      }
      return new Promise<{
        ok: boolean;
        json: () => Promise<unknown>;
      }>((resolve) => {
        resolveFetch = resolve;
      });
    });
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo/zone-flyway-test";

    const execution = context.execute();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const source = MockEventSource.instances[0];
    source.emit({ stage: "Building prompt..." });

    expect(elements.get("progressBox").classList.contains("hidden")).toBe(false);
    expect(elements.get("progressText").textContent).toBe("⏳ Building prompt...");

    if (!resolveFetch) {
      throw new Error("Fetch resolver was not assigned");
    }

    resolveFetch({
      ok: true,
      json: async () => ({
        ok: true,
        dialect: "postgresql",
        migrationFormat: "flyway",
        confidence: 91,
        summary: "Creates orders table",
        warnings: [],
        applyPatches: [],
        preview: "=== DATA ANALYST PREVIEW ===\nSummary: Creates orders table",
      }),
    });
    await execution;
  });

  it("reset clears progress state", () => {
    const { context, elements } = buildUiHarness();
    context.setProgress("Generating patch...");

    context.resetUI();

    expect(elements.get("progressText").textContent).toBe("");
    expect(elements.get("progressBox").classList.contains("hidden")).toBe(true);
  });

  it("final completion resolves progress to Ready", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          dialect: "postgresql",
          migrationFormat: "flyway",
          confidence: 91,
          summary: "Creates orders table",
          warnings: [],
          applyPatches: [],
          preview: "=== DATA ANALYST PREVIEW ===\nSummary: Creates orders table",
        }),
      });
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo/zone-flyway-test";

    await context.execute();

    expect(elements.get("progressText").textContent).toBe("⏳ Ready");
    expect(elements.get("progressBox").classList.contains("hidden")).toBe(false);
  });

  it("starting a new run resets previous progress state safely", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          dialect: "postgresql",
          migrationFormat: "flyway",
          confidence: 91,
          summary: "Creates orders table",
          warnings: [],
          applyPatches: [],
          preview: "=== DATA ANALYST PREVIEW ===\nSummary: Creates orders table",
        }),
      })
      .mockResolvedValueOnce(
        okResponse({ ok: true, plan: "Free", credits: 10, subscriptionStatus: "free" })
      )
      .mockResolvedValueOnce(okResponse({ ok: true }))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          dialect: "postgresql",
          migrationFormat: "flyway",
          confidence: 91,
          summary: "Creates orders table",
          warnings: [],
          applyPatches: [],
          preview: "=== DATA ANALYST PREVIEW ===\nSummary: Creates orders table",
        }),
      })
      .mockResolvedValueOnce(
        okResponse({ ok: true, plan: "Free", credits: 9, subscriptionStatus: "free" })
      );
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo/zone-flyway-test";

    await context.execute();
    const firstSource = MockEventSource.instances[0];
    expect(elements.get("progressText").textContent).toBe("⏳ Ready");

    await context.execute();

    expect(firstSource.closed).toBe(true);
    expect(elements.get("progressText").textContent).toBe("⏳ Ready");
  });
});


describe("BYOM.1: provider picker default and persistence", () => {
  it("getActiveProvider returns anthropic by default (no localStorage key)", () => {
    const { context } = buildUiHarness();
    const getActiveProvider = (context as unknown as { getActiveProvider: () => string })
      .getActiveProvider;
    expect(getActiveProvider()).toBe("anthropic");
  });

  it("getActiveProvider returns openai when zoneActiveProvider=openai is in localStorage", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "openai" });
    const getActiveProvider = (context as unknown as { getActiveProvider: () => string })
      .getActiveProvider;
    expect(getActiveProvider()).toBe("openai");
  });

  it("getActiveProvider returns anthropic when zoneActiveProvider=anthropic is in localStorage", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "anthropic" });
    const getActiveProvider = (context as unknown as { getActiveProvider: () => string })
      .getActiveProvider;
    expect(getActiveProvider()).toBe("anthropic");
  });

  it("buildAuthHeaders sends X-Zone-Provider: anthropic by default", () => {
    const { context } = buildUiHarness();
    const buildAuthHeaders = (
      context as unknown as { buildAuthHeaders: () => Record<string, string> }
    ).buildAuthHeaders;
    const headers = buildAuthHeaders();
    expect(headers["X-Zone-Provider"]).toBe("anthropic");
  });

  it("buildAuthHeaders sends X-Zone-Provider: openai when provider is openai", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "openai" });
    const buildAuthHeaders = (
      context as unknown as { buildAuthHeaders: () => Record<string, string> }
    ).buildAuthHeaders;
    const headers = buildAuthHeaders();
    expect(headers["X-Zone-Provider"]).toBe("openai");
  });

  it("setActiveProvider persists to localStorage and getActiveProvider reads it back", () => {
    const { context, localStorageStore } = buildUiHarness();
    const ctx = context as unknown as {
      getActiveProvider: () => string;
      setActiveProvider: (p: string) => void;
    };
    ctx.setActiveProvider("openai");
    expect(localStorageStore.get("zoneActiveProvider")).toBe("openai");
    expect(ctx.getActiveProvider()).toBe("openai");
  });
});

type ByomCtx = {
  getApiKeys: () => Record<string, string>;
  setApiKey: (provider: string, value: string) => void;
  getActiveApiKey: () => string;
  getActiveProvider: () => string;
  setActiveProvider: (p: string) => void;
  buildAuthHeaders: () => Record<string, string>;
  openSettings: (tab?: string) => void;
  closeSettings: () => void;
  syncSettingsForRunChange: () => void;
};

describe("BYOM.2: multi-key storage", () => {
  it("getApiKeys returns empty object when nothing stored", () => {
    const { context } = buildUiHarness();
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getApiKeys()).toEqual({});
  });

  it("getApiKeys parses the stored zoneApiKeys JSON", () => {
    const { context } = buildUiHarness({
      zoneApiKeys: JSON.stringify({ openai: "sk-o1", anthropic: "sk-ant-1" }),
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getApiKeys()).toEqual({ openai: "sk-o1", anthropic: "sk-ant-1" });
  });

  it("setApiKey persists each provider into its own slot", () => {
    const { context, localStorageStore } = buildUiHarness();
    const ctx = context as unknown as ByomCtx;
    ctx.setApiKey("openai", "sk-openai-key");
    ctx.setApiKey("anthropic", "sk-ant-anthropic-key");
    const raw = localStorageStore.get("zoneApiKeys");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({
      openai: "sk-openai-key",
      anthropic: "sk-ant-anthropic-key",
    });
  });

  it("setApiKey with empty value clears just that provider's slot", () => {
    const { context, localStorageStore } = buildUiHarness({
      zoneApiKeys: JSON.stringify({ openai: "sk-o", anthropic: "sk-ant" }),
    });
    const ctx = context as unknown as ByomCtx;
    ctx.setApiKey("openai", "");
    const raw = localStorageStore.get("zoneApiKeys") as string;
    expect(JSON.parse(raw)).toEqual({ anthropic: "sk-ant" });
  });

  it("setApiKey removes localStorage entry entirely when both slots clear", () => {
    const { context, localStorageStore } = buildUiHarness({
      zoneApiKeys: JSON.stringify({ openai: "sk-o" }),
    });
    const ctx = context as unknown as ByomCtx;
    ctx.setApiKey("openai", "");
    expect(localStorageStore.has("zoneApiKeys")).toBe(false);
  });

  it("setApiKey trims whitespace before storing", () => {
    const { context } = buildUiHarness();
    const ctx = context as unknown as ByomCtx;
    ctx.setApiKey("anthropic", "   sk-ant-spaces   ");
    expect(ctx.getApiKeys()).toEqual({ anthropic: "sk-ant-spaces" });
  });
});

describe("BYOM.2: active-provider key resolver", () => {
  it("getActiveApiKey returns the anthropic key when active provider is anthropic", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "anthropic",
      zoneApiKeys: JSON.stringify({ openai: "sk-o", anthropic: "sk-ant-active" }),
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getActiveApiKey()).toBe("sk-ant-active");
  });

  it("getActiveApiKey returns the openai key when active provider is openai", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "openai",
      zoneApiKeys: JSON.stringify({ openai: "sk-openai-active", anthropic: "sk-ant" }),
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getActiveApiKey()).toBe("sk-openai-active");
  });

  it("getActiveApiKey returns empty string when active provider has no key", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "openai",
      zoneApiKeys: JSON.stringify({ anthropic: "sk-ant-only" }),
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getActiveApiKey()).toBe("");
  });

  it("switching active provider switches which key getActiveApiKey returns — no manual update", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "anthropic",
      zoneApiKeys: JSON.stringify({ openai: "sk-o", anthropic: "sk-ant" }),
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getActiveApiKey()).toBe("sk-ant");
    ctx.setActiveProvider("openai");
    expect(ctx.getActiveApiKey()).toBe("sk-o");
  });

  it("buildAuthHeaders sends X-Zone-LLM-Key matching the active provider's stored key", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "anthropic",
      zoneApiKeys: JSON.stringify({ openai: "sk-o", anthropic: "sk-ant-active" }),
    });
    const ctx = context as unknown as ByomCtx;
    const headers = ctx.buildAuthHeaders();
    expect(headers["X-Zone-Provider"]).toBe("anthropic");
    expect(headers["X-Zone-LLM-Key"]).toBe("sk-ant-active");
  });

  it("buildAuthHeaders omits X-Zone-LLM-Key when the active provider has no stored key", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "openai",
      zoneApiKeys: JSON.stringify({ anthropic: "sk-ant-only" }),
    });
    const ctx = context as unknown as ByomCtx;
    const headers = ctx.buildAuthHeaders();
    expect(headers["X-Zone-Provider"]).toBe("openai");
    expect("X-Zone-LLM-Key" in headers).toBe(false);
  });

  it("buildAuthHeaders auto-rotates the transmitted key after setActiveProvider", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "anthropic",
      zoneApiKeys: JSON.stringify({ openai: "sk-o-rotated", anthropic: "sk-ant" }),
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.buildAuthHeaders()["X-Zone-LLM-Key"]).toBe("sk-ant");
    ctx.setActiveProvider("openai");
    const next = ctx.buildAuthHeaders();
    expect(next["X-Zone-Provider"]).toBe("openai");
    expect(next["X-Zone-LLM-Key"]).toBe("sk-o-rotated");
  });
});

describe("BYOM.2: legacy zoneOpenAIApiKey migration", () => {
  it("migrates legacy zoneOpenAIApiKey into zoneApiKeys.openai on harness load", () => {
    const { context, localStorageStore } = buildUiHarness({
      zoneOpenAIApiKey: "sk-legacy-openai",
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getApiKeys()).toEqual({ openai: "sk-legacy-openai" });
    expect(localStorageStore.has("zoneOpenAIApiKey")).toBe(false);
  });

  it("migration seeds zoneActiveProvider=openai when absent", () => {
    const { context, localStorageStore } = buildUiHarness({
      zoneOpenAIApiKey: "sk-legacy-only",
    });
    const ctx = context as unknown as ByomCtx;
    expect(localStorageStore.get("zoneActiveProvider")).toBe("openai");
    expect(ctx.getActiveProvider()).toBe("openai");
  });

  it("migration is a no-op when no legacy key is present (default Anthropic preserved)", () => {
    const { context, localStorageStore } = buildUiHarness();
    const ctx = context as unknown as ByomCtx;
    expect(localStorageStore.has("zoneApiKeys")).toBe(false);
    expect(ctx.getApiKeys()).toEqual({});
    expect(ctx.getActiveProvider()).toBe("anthropic");
  });

  it("migration does NOT overwrite an existing zoneApiKeys.openai slot", () => {
    const { context } = buildUiHarness({
      zoneOpenAIApiKey: "sk-legacy-stale",
      zoneApiKeys: JSON.stringify({ openai: "sk-newer-already-set" }),
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getApiKeys().openai).toBe("sk-newer-already-set");
  });

  it("migration preserves an already-set zoneActiveProvider", () => {
    const { context } = buildUiHarness({
      zoneOpenAIApiKey: "sk-legacy",
      zoneActiveProvider: "anthropic",
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getActiveProvider()).toBe("anthropic");
  });
});

describe("BYOM.2: Settings provider radios run-state gate", () => {
  it("renderKeysSettings renders OpenAI + Anthropic key inputs simultaneously", () => {
    const { context, elements } = buildUiHarness({
      zoneActiveProvider: "anthropic",
      zoneApiKeys: JSON.stringify({ anthropic: "sk-ant-saved", openai: "sk-o-saved" }),
    });
    const ctx = context as unknown as ByomCtx;
    ctx.openSettings("keys");
    const html = elements.get("settingsBody").innerHTML;
    expect(html).toContain('id="apikeyInput-openai"');
    expect(html).toContain('id="apikeyInput-anthropic"');
    expect(html).toContain('name="zoneProviderRadio"');
  });

  it("renderKeysSettings: provider radios are NOT disabled when no run is active", () => {
    const { context, elements } = buildUiHarness({ zoneActiveProvider: "anthropic" });
    const ctx = context as unknown as ByomCtx;
    ctx.openSettings("keys");
    const html = elements.get("settingsBody").innerHTML;
    // Both labels render with cursor:pointer and full opacity when not running.
    expect(html).toContain("cursor:pointer");
    expect(html).not.toContain('name="zoneProviderRadio" value="openai" checked disabled');
    expect(html).not.toContain('name="zoneProviderRadio" value="anthropic" checked disabled');
  });

  it("renderModelSettings: provider radios are NOT disabled when no run is active", () => {
    const { context, elements } = buildUiHarness({ zoneActiveProvider: "anthropic" });
    const ctx = context as unknown as ByomCtx;
    ctx.openSettings("model");
    const html = elements.get("settingsBody").innerHTML;
    expect(html).toContain('name="zoneProviderPick"');
    expect(html).not.toContain('name="zoneProviderPick" value="anthropic" checked  disabled');
  });

  it("syncSettingsForRunChange is a no-op when the Settings overlay is closed", () => {
    const { context, elements } = buildUiHarness();
    const ctx = context as unknown as ByomCtx;
    // Overlay never opened.
    const before = elements.get("settingsBody").innerHTML;
    ctx.syncSettingsForRunChange();
    expect(elements.get("settingsBody").innerHTML).toBe(before);
  });

  it("syncSettingsForRunChange re-renders the Keys tab when overlay is open", () => {
    const { context, elements } = buildUiHarness({ zoneActiveProvider: "anthropic" });
    const ctx = context as unknown as ByomCtx;
    ctx.openSettings("keys");
    // Mutate body to a sentinel; if sync re-renders, sentinel disappears.
    const body = elements.get("settingsBody");
    body.innerHTML = "<!-- SENTINEL -->";
    ctx.syncSettingsForRunChange();
    expect(body.innerHTML).not.toContain("SENTINEL");
    expect(body.innerHTML).toContain('name="zoneProviderRadio"');
  });

  it("syncSettingsForRunChange preserves in-flight Keys-tab input values across re-render", () => {
    const { context, elements } = buildUiHarness({ zoneActiveProvider: "anthropic" });
    const ctx = context as unknown as ByomCtx;
    ctx.openSettings("keys");
    // Simulate user typing into the OpenAI key input.
    const input = elements.get("apikeyInput-openai");
    input.value = "sk-typed-but-not-saved";
    ctx.syncSettingsForRunChange();
    // After re-render the input element is the same MockElement (getElementById
    // returns the cached one); the helper restores its value.
    expect(elements.get("apikeyInput-openai").value).toBe("sk-typed-but-not-saved");
  });

  it("syncSettingsForRunChange skips tabs that have no provider radios", () => {
    const { context, elements } = buildUiHarness();
    const ctx = context as unknown as ByomCtx;
    ctx.openSettings("general");
    const before = elements.get("settingsBody").innerHTML;
    ctx.syncSettingsForRunChange();
    expect(elements.get("settingsBody").innerHTML).toBe(before);
  });
});

describe("UI.3.a: model label header shows main agent model, not classifier", () => {
  it("resolveActiveModelLabel returns Sonnet 4.6 (Default) for anthropic + zone_default", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as { resolveActiveModelLabel: () => string })
      .resolveActiveModelLabel;
    expect(fn()).toBe("Sonnet 4.6 (Default)");
  });

  it("resolveActiveModelLabel ignores zoneActiveModels when preset is explicitly zone_default", () => {
    const { context } = buildUiHarness({
      // Explicitly pin preset to zone_default so migration doesn't flip it to 'custom'
      "zone.modelPreset": JSON.stringify({ preset: "zone_default" }),
      zoneActiveModels: JSON.stringify({ anthropic: { high: "claude-haiku-4-5" } }),
    });
    const fn = (context as unknown as { resolveActiveModelLabel: () => string })
      .resolveActiveModelLabel;
    // zone_default uses catalog recommended model, not localStorage value
    expect(fn()).toBe("Sonnet 4.6 (Default)");
  });
});

describe("UI.3.b: streaming diff persistence CSS hold animation", () => {
  it("livecode-static body has livecodeStaticReveal animation for hold-on-transition", () => {
    const html = readFileSync(path.resolve("src/ui/index.html"), "utf8");
    expect(html).toContain("livecodeStaticReveal");
    expect(html).toContain(".livecode-static .livecode-body");
  });
});

describe("UI.3.c: retry rich render — formatRetryLine composes errorClass + delay + attempt", () => {
  it("formatRetryLine formats 5xx with delayMs and attempt indices", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as { formatRetryLine: (p: Record<string, unknown>) => string })
      .formatRetryLine;
    const result = fn({ errorClass: "5xx", delayMs: 1200, attemptIndex: 2, maxAttempts: 3 });
    expect(result).toBe("Retry 2/3 · 5xx · wait 1.2s");
  });

  it("formatRetryLine formats 429 with rounded delay", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as { formatRetryLine: (p: Record<string, unknown>) => string })
      .formatRetryLine;
    const result = fn({ errorClass: "429", delayMs: 5000, attemptIndex: 1, maxAttempts: 4 });
    expect(result).toBe("Retry 1/4 · 429 · wait 5.0s");
  });
});
