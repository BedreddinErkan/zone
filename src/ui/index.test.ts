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
      listener({ target: this, stopPropagation: () => {}, preventDefault: () => {} });
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
    windowListeners,
    roleButtons: {
      developer: developerRoleButton,
      testEngineer: testEngineerRoleButton,
      dataAnalyst: dataAnalystRoleButton,
    },
  };
}

describe("UI repo folder picker", () => {
  it("renders the folder picker button", () => {
    const { elements } = buildUiHarness();
    expect(elements.get("folderPickerBtn")).toBeTruthy();
  });

  // Skipped: BYOM.1 refactor removed selectRepoFolder / showDirectoryPicker integration
  it.skip("shows selected folder name when showDirectoryPicker is available", async () => {
    const { context, elements } = buildUiHarness();
    context.window.showDirectoryPicker = vi
      .fn()
      .mockResolvedValue({ name: "zone-flyway-test" });

    await context.selectRepoFolder();

    expect(elements.get("repoSelectionBox").classList.contains("hidden")).toBe(false);
    expect(elements.get("repoSelectionLabel").textContent).toContain("zone-flyway-test");
  });

  // Skipped: BYOM.1 refactor removed handleFolderFallbackChange
  it.skip("uses the fallback directory input when showDirectoryPicker is unavailable", async () => {
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

  // Skipped: BYOM.1 refactor removed selectRole / queueDeveloperAsyncRun path
  it.skip("keeps manual repo path fallback working for execute", async () => {
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

  // Skipped: BYOM.1 refactor removed selectRepoFolder / resetUI folder-state clearing
  it.skip("reset clears and hides the selected folder state", async () => {
    const { context, elements } = buildUiHarness();
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue({ name: "zone-app" });

    await context.selectRepoFolder();
    context.resetUI();

    expect(elements.get("repoSelectionBox").classList.contains("hidden")).toBe(true);
    expect(elements.get("repoSelectionLabel").textContent).toBe("");
  });

  // Skipped: BYOM.1 refactor removed executeDryRun validation path
  it.skip("shows a clear validation message when no repo path is provided", async () => {
    const { context, elements } = buildUiHarness();
    elements.get("task").value = "polish spacing";

    await context.executeDryRun();

    expect(elements.get("errorBox").textContent).toContain("Task and repo path are required.");
  });

  // Skipped: BYOM.1 refactor removed unauthenticated-user execute path
  it.skip("shows a missing session message and skips requests when no authenticated user exists", async () => {
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

  // Skipped: BYOM.1 refactor removed selectRole / injected-user execute path
  it.skip("uses the injected current user id when available", async () => {
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
    expect(sidebar.querySelector(".zone-todo-plan").textContent).toContain("2/3");
    expect(sidebar.querySelector(".zone-todo-plan").textContent).toContain("Read files");
    expect(sidebar.querySelector(".zone-todo-plan").textContent).toContain("Render sidebar");
    expect(sidebar.querySelector(".zone-todo-plan").textContent).toContain("src/ui/index.html");
  });

  it("shows todos for the active thread run and hides for a new run without todos", () => {
    const { context, elements } = buildUiHarness();

    context.activateThread("thread-1");
    context.setRun("thread-1", { runId: "run-1" });
    context.setTodosForRun("run-1", [
      { id: "todo-0", text: "First thread", status: "completed" },
    ]);
    expect(elements.get("zoneTodoSidebar").querySelector(".zone-todo-plan").textContent).toContain("First thread");

    context.setRun("thread-1", { runId: "run-2" });
    expect(elements.get("zoneTodoSidebar").dataset.state).toBe("hidden");

    context.setTodosForRun("run-2", [
      { id: "todo-0", text: "Second run", status: "pending" },
    ]);
    expect(elements.get("zoneTodoSidebar").querySelector(".zone-todo-plan").textContent).toContain("Second run");
    expect(elements.get("zoneTodoSidebar").querySelector(".zone-todo-plan").textContent).not.toContain("First thread");
  });
});

describe("UI recent runs", () => {
  // Skipped: BYOM.1 refactor removed selectRole / addRecentRun-after-execute path
  it.skip("adds a recent run after a successful run", async () => {
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

  // Skipped: BYOM.1 refactor removed selectRole / failed-run addRecentRun path
  it.skip("adds a recent run after a failed run", async () => {
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

  // Skipped: BYOM.1 refactor removed recentRunsList render-from-localStorage path
  it.skip("renders recent runs in reverse chronological order", () => {
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

  // Skipped: BYOM.1 refactor removed addRecentRun function
  it.skip("caps recent runs to the maximum size", () => {
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

  // Skipped: BYOM.1 refactor removed addRecentRun / resetUI-recent-runs interaction
  it.skip("reset does not clear recent runs", () => {
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

  // Skipped: BYOM.1 refactor removed loadRecentRun / selectRole form-refill path
  it.skip("loads recent runs from localStorage and can refill the form", () => {
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

  it("getActiveProvider returns gemini when zoneActiveProvider=gemini is in localStorage", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "gemini" });
    const getActiveProvider = (context as unknown as { getActiveProvider: () => string })
      .getActiveProvider;
    expect(getActiveProvider()).toBe("gemini");
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

  it("buildAuthHeaders sends X-Zone-Provider: gemini when provider is gemini", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "gemini" });
    const buildAuthHeaders = (
      context as unknown as { buildAuthHeaders: () => Record<string, string> }
    ).buildAuthHeaders;
    const headers = buildAuthHeaders();
    expect(headers["X-Zone-Provider"]).toBe("gemini");
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

  it("setActiveProvider accepts gemini and getActiveProvider reads it back", () => {
    const { context, localStorageStore } = buildUiHarness();
    const ctx = context as unknown as {
      getActiveProvider: () => string;
      setActiveProvider: (p: string) => void;
    };
    ctx.setActiveProvider("gemini");
    expect(localStorageStore.get("zoneActiveProvider")).toBe("gemini");
    expect(ctx.getActiveProvider()).toBe("gemini");
  });
});

type ByomCtx = {
  getApiKeys: () => Record<string, string>;
  setApiKey: (provider: string, value: string) => void;
  getActiveApiKey: () => string;
  getActiveProvider: () => string;
  setActiveProvider: (p: string) => void;
  getActivePrimary: (provider: string) => string | null;
  setActivePrimary: (provider: string, modelId: string) => void;
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

  it("buildAuthHeaders sends X-Zone-LLM-Model-High when a primary model is stored", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "anthropic",
      zoneActiveModels: JSON.stringify({ anthropic: { high: "claude-opus-4-7" } }),
    });
    const ctx = context as unknown as ByomCtx;
    const headers = ctx.buildAuthHeaders();
    expect(headers["X-Zone-LLM-Model-High"]).toBe("claude-opus-4-7");
  });

  it("buildAuthHeaders omits X-Zone-LLM-Model-High when no primary model is stored", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "anthropic" });
    const ctx = context as unknown as ByomCtx;
    const headers = ctx.buildAuthHeaders();
    expect("X-Zone-LLM-Model-High" in headers).toBe(false);
  });

  it("buildAuthHeaders sends X-Zone-LLM-Model-Standard when a worker model is stored", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "anthropic",
      zoneActiveModels: JSON.stringify({ anthropic: { standard: "claude-haiku-4-5" } }),
    });
    const ctx = context as unknown as ByomCtx;
    const headers = ctx.buildAuthHeaders();
    expect(headers["X-Zone-LLM-Model-Standard"]).toBe("claude-haiku-4-5");
  });

  it("buildAuthHeaders omits X-Zone-LLM-Model-Standard when no worker model is stored", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "anthropic" });
    const ctx = context as unknown as ByomCtx;
    const headers = ctx.buildAuthHeaders();
    expect("X-Zone-LLM-Model-Standard" in headers).toBe(false);
  });
});

describe("P.3: Gemini provider round-trip", () => {
  it("setActiveProvider gemini → getActiveProvider returns gemini → headers carry gemini model", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "gemini",
      zoneApiKeys: JSON.stringify({ gemini: "AIza-test-key" }),
      zoneActiveModels: JSON.stringify({ gemini: { high: "gemini-3.1-pro" } }),
    });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getActiveProvider()).toBe("gemini");
    const headers = ctx.buildAuthHeaders();
    expect(headers["X-Zone-Provider"]).toBe("gemini");
    expect(headers["X-Zone-LLM-Key"]).toBe("AIza-test-key");
    expect(headers["X-Zone-LLM-Model-High"]).toBe("gemini-3.1-pro");
  });

  it("getActivePrimary returns null when no model stored for provider", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "gemini" });
    const ctx = context as unknown as ByomCtx;
    expect(ctx.getActivePrimary("gemini")).toBeNull();
  });

  it("setActivePrimary/getActivePrimary round-trip for gemini", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "gemini" });
    const ctx = context as unknown as ByomCtx;
    ctx.setActivePrimary("gemini", "gemini-3.5-flash");
    expect(ctx.getActivePrimary("gemini")).toBe("gemini-3.5-flash");
    const headers = ctx.buildAuthHeaders();
    expect(headers["X-Zone-LLM-Model-High"]).toBe("gemini-3.5-flash");
  });

  it("setActivePrimary/getActivePrimary round-trip for anthropic", () => {
    const { context } = buildUiHarness({ zoneActiveProvider: "anthropic" });
    const ctx = context as unknown as ByomCtx;
    ctx.setActivePrimary("anthropic", "claude-opus-4-8");
    expect(ctx.getActivePrimary("anthropic")).toBe("claude-opus-4-8");
    const headers = ctx.buildAuthHeaders();
    expect(headers["X-Zone-LLM-Model-High"]).toBe("claude-opus-4-8");
  });

  it("setActivePrimary with empty string clears stored model (omits header)", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "anthropic",
      zoneActiveModels: JSON.stringify({ anthropic: { high: "claude-opus-4-7" } }),
    });
    const ctx = context as unknown as ByomCtx;
    ctx.setActivePrimary("anthropic", "");
    expect(ctx.getActivePrimary("anthropic")).toBeNull();
    expect("X-Zone-LLM-Model-High" in ctx.buildAuthHeaders()).toBe(false);
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
    context.fetch = vi.fn().mockResolvedValue({ ok: false, json: async () => null });
    ctx.openSettings("general");
    const before = elements.get("settingsBody").innerHTML;
    ctx.syncSettingsForRunChange();
    expect(elements.get("settingsBody").innerHTML).toBe(before);
  });
});

describe("UI.3.a: model label header shows main agent model, not classifier", () => {
  it("resolveActiveModelLabel returns Sonnet 4.6 (Default) when no primary is stored", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as { resolveActiveModelLabel: () => string })
      .resolveActiveModelLabel;
    expect(fn()).toBe("Sonnet 4.6 (Default)");
  });

  it("resolveActiveModelLabel returns stored primary model label when one is set", () => {
    const { context } = buildUiHarness({
      zoneActiveModels: JSON.stringify({ anthropic: { high: "claude-haiku-4-5" } }),
    });
    const fn = (context as unknown as { resolveActiveModelLabel: () => string })
      .resolveActiveModelLabel;
    // Primary is stored → show model name without "(Default)" suffix
    expect(fn()).toBe("Haiku 4.5");
  });

  it("resolveActiveModelLabel returns full label for OpenAI primary model", () => {
    const { context } = buildUiHarness({
      zoneActiveProvider: "openai",
      zoneActiveModels: JSON.stringify({ openai: { high: "gpt-5.5" } }),
    });
    const fn = (context as unknown as { resolveActiveModelLabel: () => string })
      .resolveActiveModelLabel;
    expect(fn()).toBe("GPT-5.5");
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

type RunResultLike = {
  terminationReason?: string;
  userFacingMessage?: string;
  canResume?: boolean;
  resumeHint?: string | null;
  costUsd?: number;
  cacheHitPct?: number;
  fileDiffs?: Array<{ filePath: string }>;
};

describe("UI.5: inline prose run completion", () => {
  type Ctx = {
    buildRunSummaryBubble: (text: string, runId?: string) => { className: string; innerHTML: string } | null;
    createRunStatusLine: (r: RunResultLike) => { className: string; innerHTML: string } | null;
    createRunNextHint: (r: RunResultLike) => { className: string; textContent: string } | null;
  };

  it("buildRunSummaryBubble returns bubble.agent element containing summary text", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx).buildRunSummaryBubble;
    const el = fn("Added group and pluck utilities to the utils module.");
    expect(el).not.toBeNull();
    expect(el!.className).toContain("bubble");
    expect(el!.className).toContain("agent");
    expect(el!.innerHTML).toContain("Added group and pluck utilities");
  });

  it("buildRunSummaryBubble returns null when summary text is empty or whitespace", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx).buildRunSummaryBubble;
    expect(fn("")).toBeNull();
    expect(fn("   ")).toBeNull();
  });

  it("createRunStatusLine has category-warning class and userFacingMessage for max_iterations", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx).createRunStatusLine;
    const el = fn({
      terminationReason: "max_iterations",
      userFacingMessage: "Hit max iteration limit (25/25). Narrow the task or split.",
    });
    expect(el!.className).toContain("run-status-line");
    expect(el!.className).toContain("category-warning");
    expect(el!.innerHTML).toContain("Hit max iteration limit");
  });

  it("createRunNextHint returns run-next-hint element when canResume=true; null when canResume=false", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx).createRunNextHint;
    const hint = fn({ canResume: true, resumeHint: "Try a more focused follow-up task" });
    expect(hint!.className).toContain("run-next-hint");
    expect(hint!.textContent).toContain("Try a more focused follow-up task");
    const noHint = fn({ canResume: false, resumeHint: "Some hint" });
    expect(noHint).toBeNull();
  });
});

describe("UI.6: format switcher — parse, switch, default format", () => {
  type Ctx6 = {
    parseAgentSummary: (raw: string) => { what: string; why: string; tests: string; notes: string; isStructured: boolean; raw: string };
    getRunSummaryContext: (result: Record<string, unknown>) => { category: string; terminationReason: string; filesChanged: unknown[]; costUsd: number | null; cacheHitPct: number | null; userFacingMessage: string };
    defaultFormatFor: (category: string, terminationReason: string) => string;
    buildRunFormatSwitcher: (structured: unknown, ctx: unknown, bubbleEl: unknown, initialFmt: string) => { className: string; children: Array<{ className: string; attributes: Record<string, string> }> };
    buildRunSummaryBubble: (text: string, runId?: string) => { className: string; innerHTML: string } | null;
    applyRunFormat: (fmtId: string, structured: unknown, ctx: unknown) => string;
  };

  const WELL_FORMED = `## What changed\n- Added omit utility to src/utils/omit.ts\n\n## Why\nCompletes the symmetry with pick.\n\n## Tests\ntests_passed (npm test)\n\n## Notes\nNone.`;

  const SUCCESS_RESULT = {
    terminationReason: "natural_completion",
    userFacingMessage: "Run completed successfully",
    fileDiffs: [
      { filePath: "src/utils/omit.ts", addedLines: 12, removedLines: 0 },
    ],
    costUsd: 0.42,
    cacheHitPct: 71,
  };

  it("parseAgentSummary returns isStructured: true for 4-section input", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx6).parseAgentSummary;
    const s = fn(WELL_FORMED);
    expect(s.isStructured).toBe(true);
    expect(s.what).toContain("omit");
    expect(s.tests).toContain("tests_passed");
  });

  it("parseAgentSummary returns isStructured: false for unstructured input", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx6).parseAgentSummary;
    const s = fn("Some prose summary without sections.");
    expect(s.isStructured).toBe(false);
    expect(s.what).toContain("Some prose summary");
  });

  it("defaultFormatFor returns 'detailed' for natural_completion", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx6).defaultFormatFor;
    expect(fn("success", "natural_completion")).toBe("detailed");
  });

  it("defaultFormatFor returns 'prompt' for max_iterations", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx6).defaultFormatFor;
    expect(fn("warning", "max_iterations")).toBe("prompt");
  });

  it("defaultFormatFor returns 'brief' for upstream_unavailable", () => {
    const { context } = buildUiHarness();
    const fn = (context as unknown as Ctx6).defaultFormatFor;
    expect(fn("error", "upstream_unavailable")).toBe("brief");
  });

  it("buildRunFormatSwitcher creates row with run-format-tabs class, 5 tab children, and a copy button", () => {
    const { context } = buildUiHarness();
    const parseFn = (context as unknown as Ctx6).parseAgentSummary;
    const ctxFn = (context as unknown as Ctx6).getRunSummaryContext;
    const switcherFn = (context as unknown as Ctx6).buildRunFormatSwitcher;
    const s = parseFn(WELL_FORMED);
    const ctx = ctxFn(SUCCESS_RESULT);
    const bubbleEl = { querySelector: () => ({ innerHTML: "" }), querySelectorAll: () => [] };
    const row = switcherFn(s, ctx, bubbleEl, "detailed");
    expect(row.className).toContain("run-format-tabs");
    expect(row.children.length).toBe(6);
    expect(row.children[5].className).toContain("copy-btn");
  });

  it("buildRunFormatSwitcher marks the initial format tab as active", () => {
    const { context } = buildUiHarness();
    const parseFn = (context as unknown as Ctx6).parseAgentSummary;
    const ctxFn = (context as unknown as Ctx6).getRunSummaryContext;
    const switcherFn = (context as unknown as Ctx6).buildRunFormatSwitcher;
    const s = parseFn(WELL_FORMED);
    const ctx = ctxFn(SUCCESS_RESULT);
    const bubbleEl = { querySelector: () => ({ innerHTML: "" }), querySelectorAll: () => [] };
    const row = switcherFn(s, ctx, bubbleEl, "pr");
    const activeTabs = row.children.filter(c => c.className.includes("active"));
    expect(activeTabs.length).toBe(1);
    expect(activeTabs[0].attributes["aria-label"]).toContain("PR");
  });

  it("applyRunFormat brief output is a single line with emoji and metrics", () => {
    const { context } = buildUiHarness();
    const parseFn = (context as unknown as Ctx6).parseAgentSummary;
    const ctxFn = (context as unknown as Ctx6).getRunSummaryContext;
    const applyFn = (context as unknown as Ctx6).applyRunFormat;
    const s = parseFn(WELL_FORMED);
    const ctx = ctxFn(SUCCESS_RESULT);
    const result = applyFn("brief", s, ctx);
    expect(result).not.toContain("\n");
    expect(result).toContain("✅");
  });

  it("copy button click calls navigator.clipboard.writeText with active format output", async () => {
    const { context } = buildUiHarness();
    const writeText = vi.fn(() => Promise.resolve());
    (context.navigator.clipboard as unknown as { writeText: (t: string) => Promise<void> }).writeText = writeText;
    const parseFn = (context as unknown as Ctx6).parseAgentSummary;
    const ctxFn = (context as unknown as Ctx6).getRunSummaryContext;
    const switcherFn = (context as unknown as Ctx6).buildRunFormatSwitcher;
    const applyFn = (context as unknown as Ctx6).applyRunFormat;
    const s = parseFn(WELL_FORMED);
    const ctx = ctxFn(SUCCESS_RESULT);
    const bubbleEl = { querySelector: () => ({ innerHTML: "" }), querySelectorAll: () => [] };
    const row = switcherFn(s, ctx, bubbleEl, "pr");
    const copyBtn = row.children[5];
    copyBtn.click();
    await new Promise(r => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalledWith(applyFn("pr", s, ctx));
  });

  it("copy button click shows 'Copied as {FormatName}' toast", async () => {
    const { context, elements } = buildUiHarness();
    const parseFn = (context as unknown as Ctx6).parseAgentSummary;
    const ctxFn = (context as unknown as Ctx6).getRunSummaryContext;
    const switcherFn = (context as unknown as Ctx6).buildRunFormatSwitcher;
    const s = parseFn(WELL_FORMED);
    const ctx = ctxFn(SUCCESS_RESULT);
    const bubbleEl = { querySelector: () => ({ innerHTML: "" }), querySelectorAll: () => [] };
    const row = switcherFn(s, ctx, bubbleEl, "slack");
    const copyBtn = row.children[5];
    copyBtn.click();
    await new Promise(r => setTimeout(r, 0));
    const chatArea = elements.get("chatArea");
    const toastChildren = chatArea.children.filter(c => c.className.includes("toast"));
    expect(toastChildren.length).toBeGreaterThan(0);
    const lastToast = toastChildren[toastChildren.length - 1];
    // toast structure: children[0] = ticon, children[1] = text div
    const toastText = lastToast.children[1]?.textContent ?? lastToast.textContent;
    expect(toastText).toContain("Copied as Slack");
  });

  it("Cmd/Ctrl+Shift+C keyboard shortcut triggers clipboard write for most recent format switcher", async () => {
    const { context, windowListeners } = buildUiHarness();
    const writeText = vi.fn(() => Promise.resolve());
    (context.navigator.clipboard as unknown as { writeText: (t: string) => Promise<void> }).writeText = writeText;
    const parseFn = (context as unknown as Ctx6).parseAgentSummary;
    const ctxFn = (context as unknown as Ctx6).getRunSummaryContext;
    const switcherFn = (context as unknown as Ctx6).buildRunFormatSwitcher;
    const s = parseFn(WELL_FORMED);
    const ctx = ctxFn(SUCCESS_RESULT);
    const bubbleEl = { querySelector: () => ({ innerHTML: "" }), querySelectorAll: () => [] };
    switcherFn(s, ctx, bubbleEl, "brief");
    const keydownListeners = windowListeners.get("document:keydown") ?? [];
    const prevented: boolean[] = [];
    for (const listener of keydownListeners) {
      listener({ key: "c", ctrlKey: true, shiftKey: true, metaKey: false, preventDefault: () => prevented.push(true) });
    }
    await new Promise(r => setTimeout(r, 0));
    expect(writeText).toHaveBeenCalled();
    expect(prevented.length).toBeGreaterThan(0);
  });
});

describe("D6: repo dropdown — custom path support", () => {
  it("repo dropdown renders '+ Add custom path' entry at bottom of list", () => {
    const { elements } = buildUiHarness();
    const list = elements.get("repoDropdownList");
    // With empty state.repos, list has: [sep, addRow]
    const addRow = list.children[list.children.length - 1];
    expect(addRow).toBeTruthy();
    expect(addRow.textContent).toContain("+ Add custom path");
  });

  it("clicking add row shows inline dialog with label and path inputs", () => {
    const { elements } = buildUiHarness();
    const list = elements.get("repoDropdownList");
    // With empty repos: list.children = [sep, addRow]
    const addRow = list.children[list.children.length - 1];
    addRow.click(); // triggers state.__addingProject = true + re-render
    // After re-render: list.children = [sep, form-wrap]
    // form-wrap.children = [browseBtn, labelInput, input, addBtn]
    const inputs: MockElement[] = [];
    function collect(node: MockElement) {
      for (const child of node.children) {
        if ((child as unknown as { type?: string }).type === "text") inputs.push(child);
        collect(child);
      }
    }
    collect(list);
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    const placeholders = inputs.map(inp => inp.placeholder);
    expect(placeholders.some(p => /label/i.test(p))).toBe(true);
    expect(placeholders.some(p => /path/i.test(p))).toBe(true);
  });
});
