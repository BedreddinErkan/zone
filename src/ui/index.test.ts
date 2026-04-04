import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

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
  textContent = "";
  innerText = "";
  innerHTML = "";
  value = "";
  placeholder = "";
  title = "";
  disabled = false;
  files: Array<{ name?: string; webkitRelativePath?: string }> = [];
  clicked = false;
  dataset: Record<string, string> = {};
  private classListValue: MockClassList;

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

  click(): void {
    this.clicked = true;
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
  content = "";
  writable = new MockWritableFile(this);

  async createWritable(): Promise<MockWritableFile> {
    return this.writable;
  }

  async getFile(): Promise<{ text(): Promise<string> }> {
    return {
      text: async () => this.content,
    };
  }
}

class MockDirectoryHandle {
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
      this.files.set(name, new MockFileHandle());
    }
    return this.files.get(name)!;
  }

  async removeEntry(name: string): Promise<void> {
    this.files.delete(name);
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

function buildUiHarness(initialLocalStorage: Record<string, string> = {}) {
  const html = readFileSync(
    path.resolve("src/ui/index.html"),
    "utf8"
  );
  const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
  if (!scriptMatch) {
    throw new Error("UI script not found");
  }

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
  const context: UiContextBase = {
    document,
    localStorage: {
      getItem(key: string) {
        return localStorageStore.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        localStorageStore.set(key, value);
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
    fetch: vi.fn(),
    EventSource: MockEventSource,
    window: {
      location: { href: "" },
      showDirectoryPicker: vi.fn(),
    },
    Math,
    Date,
    encodeURIComponent,
  };
  (context as UiContextBase & { window: UiContext["window"] }).window.showDirectoryPicker =
    vi.fn();
  (context as UiContextBase & { window: UiContext["window"] }).window = Object.assign(
    context,
    context.window
  );

  MockEventSource.instances = [];
  vm.runInNewContext(scriptMatch[1], context as vm.Context);
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
    context.fetch = vi
      .fn()
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

    expect(context.fetch).toHaveBeenCalledWith(
      "/api/analyze",
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
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue({ name: "zone-app" });
    elements.get("task").value = "polish spacing";

    await context.selectRepoFolder();
    await context.executeDryRun();

    expect(elements.get("errorBox").textContent).toContain("Select a local repo path for Execute and Dry Run.");
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
    context.fetch = vi
      .fn()
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
          patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Fix login flow",
          warnings: [],
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
        }),
      });

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
    context.fetch = vi
      .fn()
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
          patchPreview: "=== LLM PATCH PREVIEW ===\nSummary: Fix login flow",
          warnings: [],
          applyPatches: [],
        }),
      });

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
    context.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));
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
});

describe("UI folder-handle apply", () => {
  it("keeps Apply disabled with an exact blocking reason until both a patch and folder handle exist", async () => {
    const { context, elements, roleButtons } = buildUiHarness();

    expect(elements.get("applyBtn").disabled).toBe(true);
    expect(elements.get("applyStatusBox").textContent).toContain("Run Execute first");

    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Fix login flow",
          warnings: [],
          applyPatches: [
            {
              filePath: "src/features/login.ts",
              fullContent: "export const login = true;",
            },
          ],
        }),
      });
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();

    expect(elements.get("applyBtn").disabled).toBe(true);
    expect(elements.get("decisionBadge").className).toContain("safe");
    expect(elements.get("applyStatusBox").textContent).toContain("Safe to apply once a folder is selected");
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
    expect(elements.get("applyBtn").disabled).toBe(true);
    expect(elements.get("applyStatusBox").textContent).toContain("Safe to apply once a folder is selected");
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
    expect(elements.get("applyStatusBox").textContent).toContain("Output validation blocked this result");
    expect(elements.get("applyStatusBox").textContent).not.toContain("Ready to apply");
    expect(elements.get("errorBox").textContent).toContain("Output validation blocked");
  });

  it("starting a new run clears stale apply success and restore state before showing a blocked preview", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Fix login flow",
          warnings: [],
          applyPatches: [
            {
              filePath: "src/features/login.ts",
              fullContent: "export const login = true;",
            },
          ],
        }),
      })
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
      });

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
    expect(elements.get("applyStatusBox").textContent).toContain("Output validation blocked this result");
  });

  it("writes files through the selected folder handle", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Fix login flow",
          warnings: [],
          applyPatches: [
            {
              filePath: "src/features/login.ts",
              fullContent: "export const login = true;",
            },
          ],
        }),
      });

    await context.selectRepoFolder();
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();
    await context.applyChanges();

    expect(elements.get("applyBtn").disabled).toBe(false);
    expect(elements.get("applyStatusBox").textContent).toContain("Ready to apply");
    const srcDir = await rootHandle.getDirectoryHandle("src");
    const featuresDir = await srcDir.getDirectoryHandle("features");
    const fileHandle = await featuresDir.getFileHandle("login.ts");
    expect(fileHandle.writable.written).toBe("export const login = true;");
    expect(elements.get("successBox").innerHTML).toContain("Applied successfully");
    expect(elements.get("successBox").innerHTML).toContain("file written");
    expect(elements.get("successBox").innerHTML).toContain(">1</strong>");
    expect(elements.get("successBox").innerHTML).toContain("src/features/login.ts");
    expect(elements.get("successBox").innerHTML).toContain("Target folder: zone-repo");
    expect(elements.get("successBox").innerHTML).toContain("Restore is ready for this session.");
    expect(elements.get("restoreBtn").classList.contains("hidden")).toBe(false);
  });

  it("shows a compact multi-file apply summary when multiple files are written", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Update repo files",
          warnings: [],
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
        }),
      });

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
    expect(elements.get("successBox").innerHTML).toContain("+1 more file");
    expect(elements.get("successBox").innerHTML).not.toContain("src/api/server.ts");
  });

  it("shows an error when no folder handle is available during apply", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Fix login flow",
          warnings: [],
          applyPatches: [
            {
              filePath: "src/features/login.ts",
              fullContent: "export const login = true;",
            },
          ],
        }),
      });

    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();
    await context.applyChanges();

    expect(elements.get("errorBox").textContent).toContain("Safe to apply once a folder is selected for local Apply.");
  });

  it("handles permission errors gracefully and reset clears the handle", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const deniedHandle = new MockDirectoryHandle("zone-repo", "denied");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(deniedHandle);
    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Fix login flow",
          warnings: [],
          applyPatches: [
            {
              filePath: "src/features/login.ts",
              fullContent: "export const login = true;",
            },
          ],
        }),
      });

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
    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Fix login flow",
          warnings: [],
          applyPatches: [
            {
              filePath: "src/features/login.ts",
              fullContent: "export const login = true;",
            },
          ],
        }),
      });
    await context.execute();
    await context.applyChanges();
    expect(elements.get("errorBox").textContent).toContain("Safe to apply once a folder is selected for local Apply.");
  });

  it("keeps apply summary safe when no files are written", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    const rootHandle = new MockDirectoryHandle("zone-repo");
    context.window.showDirectoryPicker = vi.fn().mockResolvedValue(rootHandle);
    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Fix login flow",
          warnings: [],
          applyPatches: [
            {
              filePath: "/",
              fullContent: "export const login = true;",
            },
          ],
        }),
      });
    await context.selectRepoFolder();
    context.selectRole(roleButtons.developer);
    elements.get("task").value = "fix login flow";
    elements.get("repoPath").value = "C:/repo";

    await context.execute();
    await context.applyChanges();

    expect(elements.get("successBox").innerHTML).toContain("No files were written");
    expect(elements.get("successBox").innerHTML).toContain("Target folder: zone-repo");
    expect(elements.get("restoreBtn").classList.contains("hidden")).toBe(true);
  });

  it("keeps apply summary safe when no patches exist", async () => {
    const { context, elements } = buildUiHarness();
    await context.applyChanges();
    expect(elements.get("errorBox").textContent).toContain("Run Execute first to generate a patch result before applying.");
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
    context.fetch = vi
      .fn()
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
          patchPreview: "Summary: Fix login flow",
          warnings: [],
          applyPatches: [
            {
              filePath: "src/features/login.ts",
              fullContent: "export const login = true;",
            },
          ],
        }),
      });

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
  it("renders progress while a run is in progress", async () => {
    const { context, elements, roleButtons } = buildUiHarness();
    let resolveFetch: ((value: {
      ok: boolean;
      json: () => Promise<unknown>;
    }) => void) | undefined;
    context.fetch = vi.fn().mockImplementation(
      () =>
        new Promise<{
          ok: boolean;
          json: () => Promise<unknown>;
        }>((resolve) => {
          resolveFetch = resolve;
        })
    );
    context.selectRole(roleButtons.dataAnalyst);
    elements.get("task").value = "create orders table";
    elements.get("repoPath").value = "C:/repo/zone-flyway-test";

    const execution = context.execute();
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
    context.fetch = vi.fn().mockResolvedValue({
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
      .mockResolvedValue({
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
    const firstSource = MockEventSource.instances[0];
    expect(elements.get("progressText").textContent).toBe("⏳ Ready");

    await context.execute();

    expect(firstSource.closed).toBe(true);
    expect(elements.get("progressText").textContent).toBe("⏳ Ready");
  });
});
