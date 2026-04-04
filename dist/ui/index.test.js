"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_vm_1 = __importDefault(require("node:vm"));
const vitest_1 = require("vitest");
class MockClassList {
    classes = new Set();
    constructor(initial = "") {
        for (const className of initial.split(/\s+/).filter(Boolean)) {
            this.classes.add(className);
        }
    }
    add(...names) {
        for (const name of names)
            this.classes.add(name);
    }
    remove(...names) {
        for (const name of names)
            this.classes.delete(name);
    }
    contains(name) {
        return this.classes.has(name);
    }
    setFromString(value) {
        this.classes = new Set(value.split(/\s+/).filter(Boolean));
    }
    toString() {
        return [...this.classes].join(" ");
    }
}
class MockElement {
    id;
    style = {};
    textContent = "";
    innerText = "";
    innerHTML = "";
    value = "";
    placeholder = "";
    title = "";
    disabled = false;
    files = [];
    clicked = false;
    dataset = {};
    classListValue;
    constructor(id, className = "") {
        this.id = id;
        this.classListValue = new MockClassList(className);
    }
    get classList() {
        return this.classListValue;
    }
    get className() {
        return this.classListValue.toString();
    }
    set className(value) {
        this.classListValue.setFromString(value);
    }
    click() {
        this.clicked = true;
    }
    scrollIntoView() {
        // no-op for test harness
    }
}
class MockEventSource {
    static instances = [];
    url;
    onmessage = null;
    onerror = null;
    closed = false;
    constructor(url) {
        this.url = url;
        MockEventSource.instances.push(this);
    }
    emit(data) {
        this.onmessage?.({
            data: typeof data === "string" ? data : JSON.stringify(data),
        });
    }
    close() {
        this.closed = true;
    }
}
class MockWritableFile {
    fileHandle;
    written = "";
    constructor(fileHandle) {
        this.fileHandle = fileHandle;
    }
    async write(value) {
        this.written = value;
        this.fileHandle.content = value;
    }
    async close() {
        // no-op
    }
}
class MockFileHandle {
    content = "";
    writable = new MockWritableFile(this);
    async createWritable() {
        return this.writable;
    }
    async getFile() {
        return {
            text: async () => this.content,
        };
    }
}
class MockDirectoryHandle {
    name;
    permissionState;
    directories = new Map();
    files = new Map();
    constructor(name, permissionState = "granted") {
        this.name = name;
        this.permissionState = permissionState;
    }
    async queryPermission() {
        return this.permissionState;
    }
    async requestPermission() {
        return this.permissionState;
    }
    async getDirectoryHandle(name, options) {
        if (!this.directories.has(name)) {
            if (!options?.create) {
                throw new Error(`Directory not found: ${name}`);
            }
            this.directories.set(name, new MockDirectoryHandle(name, this.permissionState));
        }
        return this.directories.get(name);
    }
    async getFileHandle(name, options) {
        if (!this.files.has(name)) {
            if (!options?.create) {
                throw new Error(`File not found: ${name}`);
            }
            this.files.set(name, new MockFileHandle());
        }
        return this.files.get(name);
    }
    async removeEntry(name) {
        this.files.delete(name);
    }
}
function buildUiHarness(initialLocalStorage = {}) {
    const html = (0, node_fs_1.readFileSync)(node_path_1.default.resolve("src/ui/index.html"), "utf8");
    const scriptMatch = html.match(/<script>([\s\S]*)<\/script>/);
    if (!scriptMatch) {
        throw new Error("UI script not found");
    }
    const elements = new Map();
    const ensureElement = (id, className = "") => {
        if (!elements.has(id)) {
            elements.set(id, new MockElement(id, className));
        }
        return elements.get(id);
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
        getElementById(id) {
            return ensureElement(id);
        },
        querySelector(selector) {
            if (selector === ".prompt-box") {
                return promptBox;
            }
            if (selector === ".copy-btn") {
                return copyButton;
            }
            return new MockElement("query");
        },
        querySelectorAll(selector) {
            if (selector === ".role-btn") {
                return roleButtons;
            }
            return [];
        },
    };
    const localStorageStore = new Map(Object.entries(initialLocalStorage));
    const context = {
        document,
        localStorage: {
            getItem(key) {
                return localStorageStore.get(key) ?? null;
            },
            setItem(key, value) {
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
        fetch: vitest_1.vi.fn(),
        EventSource: MockEventSource,
        window: {
            location: { href: "" },
            showDirectoryPicker: vitest_1.vi.fn(),
        },
        Math,
        Date,
        encodeURIComponent,
    };
    context.window.showDirectoryPicker =
        vitest_1.vi.fn();
    context.window = Object.assign(context, context.window);
    MockEventSource.instances = [];
    node_vm_1.default.runInNewContext(scriptMatch[1], context);
    return {
        context: context,
        elements: { get: ensureElement },
        localStorageStore,
        roleButtons: {
            developer: developerRoleButton,
            testEngineer: testEngineerRoleButton,
            dataAnalyst: dataAnalystRoleButton,
        },
    };
}
(0, vitest_1.describe)("UI complexity badge", () => {
    (0, vitest_1.it)("shows complexity badge when complexity is present", () => {
        const { context, elements } = buildUiHarness();
        context.showDecision({
            decision: { mode: "safe_to_apply" },
            confidence: { score: 88 },
            risk: { score: 0, breakdown: {} },
            frameworkBadge: "playwright_ts / typescript",
            complexity: "data_driven",
        });
        const badge = elements.get("complexityBadge");
        (0, vitest_1.expect)(badge.textContent).toBe("Data Driven");
        (0, vitest_1.expect)(badge.classList.contains("hidden")).toBe(false);
        (0, vitest_1.expect)(badge.className).toContain("data_driven");
    });
    (0, vitest_1.it)("hides and clears complexity badge on reset", () => {
        const { context, elements } = buildUiHarness();
        context.showDecision({
            decision: { mode: "safe_to_apply" },
            confidence: { score: 88 },
            risk: { score: 0, breakdown: {} },
            complexity: "negative",
        });
        context.resetUI();
        const badge = elements.get("complexityBadge");
        (0, vitest_1.expect)(badge.textContent).toBe("");
        (0, vitest_1.expect)(badge.classList.contains("hidden")).toBe(true);
    });
    (0, vitest_1.it)("remains stable when complexity is absent", () => {
        const { context, elements } = buildUiHarness();
        context.showDecision({
            decision: { mode: "preview_only" },
            confidence: { score: 60 },
            risk: { score: 0, breakdown: {} },
            frameworkBadge: "pytest / python",
        });
        const badge = elements.get("complexityBadge");
        (0, vitest_1.expect)(badge.textContent).toBe("");
        (0, vitest_1.expect)(badge.classList.contains("hidden")).toBe(true);
    });
});
(0, vitest_1.describe)("UI repo folder picker", () => {
    (0, vitest_1.it)("renders the folder picker button", () => {
        const { elements } = buildUiHarness();
        (0, vitest_1.expect)(elements.get("folderPickerBtn")).toBeTruthy();
    });
    (0, vitest_1.it)("shows selected folder name when showDirectoryPicker is available", async () => {
        const { context, elements } = buildUiHarness();
        context.window.showDirectoryPicker = vitest_1.vi
            .fn()
            .mockResolvedValue({ name: "zone-flyway-test" });
        await context.selectRepoFolder();
        (0, vitest_1.expect)(elements.get("repoSelectionBox").classList.contains("hidden")).toBe(false);
        (0, vitest_1.expect)(elements.get("repoSelectionLabel").textContent).toContain("zone-flyway-test");
    });
    (0, vitest_1.it)("uses the fallback directory input when showDirectoryPicker is unavailable", async () => {
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
        (0, vitest_1.expect)(fallback.clicked).toBe(true);
        (0, vitest_1.expect)(elements.get("repoSelectionLabel").textContent).toContain("zone-ui");
    });
    (0, vitest_1.it)("keeps manual repo path fallback working for execute", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(context.fetch).toHaveBeenCalledWith("/api/analyze", vitest_1.expect.objectContaining({ method: "POST" }));
    });
    (0, vitest_1.it)("reset clears and hides the selected folder state", async () => {
        const { context, elements } = buildUiHarness();
        context.window.showDirectoryPicker = vitest_1.vi.fn().mockResolvedValue({ name: "zone-app" });
        await context.selectRepoFolder();
        context.resetUI();
        (0, vitest_1.expect)(elements.get("repoSelectionBox").classList.contains("hidden")).toBe(true);
        (0, vitest_1.expect)(elements.get("repoSelectionLabel").textContent).toBe("");
    });
    (0, vitest_1.it)("shows a clear validation message when no repo path is provided", async () => {
        const { context, elements } = buildUiHarness();
        context.window.showDirectoryPicker = vitest_1.vi.fn().mockResolvedValue({ name: "zone-app" });
        elements.get("task").value = "polish spacing";
        await context.selectRepoFolder();
        await context.executeDryRun();
        (0, vitest_1.expect)(elements.get("errorBox").textContent).toContain("Select a local repo path for Execute and Dry Run.");
    });
});
(0, vitest_1.describe)("UI result summary", () => {
    (0, vitest_1.it)("renders a compact summary header with available metadata", () => {
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
        (0, vitest_1.expect)(elements.get("resultSummaryTitle").textContent).toBe("Test Engineer Result");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).toContain("Status: Safe to Apply");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).toContain("Files: 1");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).toContain("Warnings: 1");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).toContain("Framework: playwright_ts");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).toContain("Complexity: Data Driven");
    });
    (0, vitest_1.it)("handles missing optional summary fields safely", () => {
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
        (0, vitest_1.expect)(elements.get("resultSummaryTitle").textContent).toBe("Developer Result");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).toContain("Status: Preview Only");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).toContain("Warnings: 0");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).not.toContain("Framework:");
        (0, vitest_1.expect)(elements.get("resultSummaryChips").innerHTML).not.toContain("Complexity:");
    });
});
(0, vitest_1.describe)("UI data analyst flow", () => {
    (0, vitest_1.it)("calls the data analyst endpoint when that role is selected", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        const fetchMock = vitest_1.vi.fn().mockResolvedValue({
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
        (0, vitest_1.expect)(fetchMock).toHaveBeenCalledWith("/api/data-analyst", vitest_1.expect.objectContaining({
            method: "POST",
        }));
    });
    (0, vitest_1.it)("renders returned SQL preview and warnings for data analyst results", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi.fn().mockResolvedValue({
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
        (0, vitest_1.expect)(elements.get("frameworkBadge").textContent).toBe("🔍 postgresql / flyway");
        (0, vitest_1.expect)(elements.get("patchSummary").textContent).toBe("Creates orders table");
        (0, vitest_1.expect)(String(elements.get("filesVal").textContent)).toBe("1");
        (0, vitest_1.expect)(elements.get("warningsList").classList.contains("hidden")).toBe(false);
        (0, vitest_1.expect)(elements.get("warningsList").innerHTML).toContain("SQL_MISSING_PRIMARY_KEY");
        (0, vitest_1.expect)(elements.get("patchSection").classList.contains("hidden")).toBe(false);
    });
    (0, vitest_1.it)("reset clears data analyst result state cleanly", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi.fn().mockResolvedValue({
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
        (0, vitest_1.expect)(elements.get("decisionSection").classList.contains("hidden")).toBe(true);
        (0, vitest_1.expect)(elements.get("patchSection").classList.contains("hidden")).toBe(true);
        (0, vitest_1.expect)(elements.get("warningsList").classList.contains("hidden")).toBe(true);
        (0, vitest_1.expect)(elements.get("repoPath").value).toBe("");
        (0, vitest_1.expect)(elements.get("task").value).toBe("");
    });
    (0, vitest_1.it)("remains stable when optional data analyst metadata is missing", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi.fn().mockResolvedValue({
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
        (0, vitest_1.expect)(elements.get("frameworkBadge").classList.contains("hidden")).toBe(true);
        (0, vitest_1.expect)(elements.get("patchSection").classList.contains("hidden")).toBe(false);
        (0, vitest_1.expect)(elements.get("patchSummary").textContent).toBe("Creates orders table");
    });
});
(0, vitest_1.describe)("UI developer context files", () => {
    (0, vitest_1.it)("shows context files for developer runs when available", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("contextFilesBox").classList.contains("hidden")).toBe(false);
        (0, vitest_1.expect)(elements.get("contextFilesList").innerHTML).toContain("src/components/LoginForm.tsx");
        (0, vitest_1.expect)(elements.get("contextFilesList").innerHTML).toContain("server/routes/auth.ts");
    });
    (0, vitest_1.it)("hides context files when they are absent", () => {
        const { context, elements } = buildUiHarness();
        context.showPatch({
            ok: true,
            patchPreview: "Summary: Preview",
            warnings: [],
            applyPatches: [],
        });
        (0, vitest_1.expect)(elements.get("contextFilesBox").classList.contains("hidden")).toBe(true);
        (0, vitest_1.expect)(elements.get("contextFilesList").innerHTML).toBe("");
    });
    (0, vitest_1.it)("reset clears developer context files", () => {
        const { context, elements } = buildUiHarness();
        context.showPatch({
            ok: true,
            patchPreview: "Summary: Preview",
            warnings: [],
            contextFiles: ["src/components/LoginForm.tsx"],
            applyPatches: [],
        });
        context.resetUI();
        (0, vitest_1.expect)(elements.get("contextFilesBox").classList.contains("hidden")).toBe(true);
        (0, vitest_1.expect)(elements.get("contextFilesList").innerHTML).toBe("");
    });
});
(0, vitest_1.describe)("UI recent runs", () => {
    (0, vitest_1.it)("adds a recent run after a successful run", async () => {
        const { context, elements, roleButtons, localStorageStore } = buildUiHarness();
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("recentRunsEmpty").classList.contains("hidden")).toBe(true);
        (0, vitest_1.expect)(elements.get("recentRunsList").innerHTML).toContain("fix login flow");
        (0, vitest_1.expect)(elements.get("recentRunsList").innerHTML).toContain("success");
        (0, vitest_1.expect)(localStorageStore.get("zone_recent_runs")).toContain("fix login flow");
    });
    (0, vitest_1.it)("adds a recent run after a failed run", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi.fn().mockRejectedValue(new Error("Network failure"));
        context.selectRole(roleButtons.developer);
        elements.get("task").value = "fix login flow";
        elements.get("repoPath").value = "C:/repo";
        await context.execute();
        (0, vitest_1.expect)(elements.get("recentRunsList").innerHTML).toContain("error");
        (0, vitest_1.expect)(elements.get("recentRunsList").innerHTML).toContain("fix login flow");
    });
    (0, vitest_1.it)("renders recent runs in reverse chronological order", () => {
        const seededRuns = JSON.stringify([
            { task: "older run", role: "developer", repoPath: "C:/old", status: "success", timestamp: 1 },
            { task: "newer run", role: "test_engineer", repoPath: "C:/new", status: "error", timestamp: 2 },
        ]);
        const { elements } = buildUiHarness({
            zone_recent_runs: seededRuns,
        });
        const html = elements.get("recentRunsList").innerHTML;
        (0, vitest_1.expect)(html.indexOf("newer run")).toBeLessThan(html.indexOf("older run"));
    });
    (0, vitest_1.it)("caps recent runs to the maximum size", () => {
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
        (0, vitest_1.expect)(saved).toHaveLength(6);
        (0, vitest_1.expect)(saved[0].task).toBe("task 7");
        (0, vitest_1.expect)(saved[5].task).toBe("task 2");
    });
    (0, vitest_1.it)("reset does not clear recent runs", () => {
        const { context, elements } = buildUiHarness();
        context.addRecentRun({
            task: "fix login flow",
            role: "developer",
            repoPath: "C:/repo",
            status: "success",
            timestamp: Date.now(),
        });
        context.resetUI();
        (0, vitest_1.expect)(elements.get("recentRunsList").innerHTML).toContain("fix login flow");
    });
    (0, vitest_1.it)("stays stable when recent runs are empty", () => {
        const { elements } = buildUiHarness();
        (0, vitest_1.expect)(elements.get("recentRunsEmpty").classList.contains("hidden")).toBe(false);
        (0, vitest_1.expect)(elements.get("recentRunsList").classList.contains("hidden")).toBe(true);
    });
    (0, vitest_1.it)("loads recent runs from localStorage and can refill the form", () => {
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
        (0, vitest_1.expect)(elements.get("task").value).toBe("create orders table");
        (0, vitest_1.expect)(elements.get("repoPath").value).toBe("C:/repo/zone-flyway-test");
        (0, vitest_1.expect)(roleButtons.dataAnalyst.classList.contains("active")).toBe(true);
    });
});
(0, vitest_1.describe)("UI patch preview", () => {
    (0, vitest_1.it)("renders grouped patch preview by file", () => {
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
        (0, vitest_1.expect)(elements.get("fileList").innerHTML).toContain("<details");
        (0, vitest_1.expect)(elements.get("fileList").innerHTML).toContain("db/migration/V3__orders.sql");
        (0, vitest_1.expect)(elements.get("fileList").innerHTML).toContain("src/test/resources/features/login.feature");
    });
    (0, vitest_1.it)("renders collapsible preview content with the first file expanded", () => {
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
        (0, vitest_1.expect)(elements.get("fileList").innerHTML).toContain("<pre>");
        (0, vitest_1.expect)(elements.get("fileList").innerHTML).toContain("await page.goto(&#39;/login&#39;);");
        (0, vitest_1.expect)(elements.get("fileList").innerHTML).toContain("<details class=\"file-card file-toggle\" open>");
    });
    (0, vitest_1.it)("remains stable when file metadata is partially missing", () => {
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
        (0, vitest_1.expect)(elements.get("fileList").innerHTML).toContain("generated_file_1");
        (0, vitest_1.expect)(elements.get("fileList").innerHTML).toContain("SELECT 1;");
    });
});
(0, vitest_1.describe)("UI folder-handle apply", () => {
    (0, vitest_1.it)("keeps Apply disabled with an exact blocking reason until both a patch and folder handle exist", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        (0, vitest_1.expect)(elements.get("applyBtn").disabled).toBe(true);
        (0, vitest_1.expect)(elements.get("applyStatusBox").textContent).toContain("Run Execute first");
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("applyBtn").disabled).toBe(true);
        (0, vitest_1.expect)(elements.get("applyStatusBox").textContent).toContain("Select a folder");
    });
    (0, vitest_1.it)("writes files through the selected folder handle", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        const rootHandle = new MockDirectoryHandle("zone-repo");
        context.window.showDirectoryPicker = vitest_1.vi.fn().mockResolvedValue(rootHandle);
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("applyBtn").disabled).toBe(false);
        (0, vitest_1.expect)(elements.get("applyStatusBox").textContent).toContain("Ready to apply");
        const srcDir = await rootHandle.getDirectoryHandle("src");
        const featuresDir = await srcDir.getDirectoryHandle("features");
        const fileHandle = await featuresDir.getFileHandle("login.ts");
        (0, vitest_1.expect)(fileHandle.writable.written).toBe("export const login = true;");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("Applied successfully");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("file written");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain(">1</strong>");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("src/features/login.ts");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("Target folder: zone-repo");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("Restore is ready for this session.");
        (0, vitest_1.expect)(elements.get("restoreBtn").classList.contains("hidden")).toBe(false);
    });
    (0, vitest_1.it)("shows a compact multi-file apply summary when multiple files are written", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        const rootHandle = new MockDirectoryHandle("zone-repo");
        context.window.showDirectoryPicker = vitest_1.vi.fn().mockResolvedValue(rootHandle);
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("files written");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain(">6</strong>");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("created");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("modified");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("src/features/login.ts");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("db/migration/V1__init.sql");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("tests/login.spec.ts");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("src/ui/index.html");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("README.md");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("+1 more file");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).not.toContain("src/api/server.ts");
    });
    (0, vitest_1.it)("shows an error when no folder handle is available during apply", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("errorBox").textContent).toContain("Select a folder to enable local Apply.");
    });
    (0, vitest_1.it)("handles permission errors gracefully and reset clears the handle", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        const deniedHandle = new MockDirectoryHandle("zone-repo", "denied");
        context.window.showDirectoryPicker = vitest_1.vi.fn().mockResolvedValue(deniedHandle);
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("errorBox").textContent).toContain("Write permission denied");
        context.resetUI();
        elements.get("task").value = "fix login flow";
        elements.get("repoPath").value = "C:/repo";
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("errorBox").textContent).toContain("Select a folder to enable local Apply.");
    });
    (0, vitest_1.it)("keeps apply summary safe when no files are written", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        const rootHandle = new MockDirectoryHandle("zone-repo");
        context.window.showDirectoryPicker = vitest_1.vi.fn().mockResolvedValue(rootHandle);
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("No files were written");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("Target folder: zone-repo");
        (0, vitest_1.expect)(elements.get("restoreBtn").classList.contains("hidden")).toBe(true);
    });
    (0, vitest_1.it)("keeps apply summary safe when no patches exist", async () => {
        const { context, elements } = buildUiHarness();
        await context.applyChanges();
        (0, vitest_1.expect)(elements.get("errorBox").textContent).toContain("Run Execute first to generate a patch result before applying.");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toBe("");
    });
    (0, vitest_1.it)("restores original file contents after apply", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        const rootHandle = new MockDirectoryHandle("zone-repo");
        const srcDir = await rootHandle.getDirectoryHandle("src", { create: true });
        const featuresDir = await srcDir.getDirectoryHandle("features", { create: true });
        const fileHandle = await featuresDir.getFileHandle("login.ts", { create: true });
        fileHandle.content = "export const login = false;";
        context.window.showDirectoryPicker = vitest_1.vi.fn().mockResolvedValue(rootHandle);
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(fileHandle.content).toBe("export const login = true;");
        await context.restorePreviousState();
        (0, vitest_1.expect)(fileHandle.content).toBe("export const login = false;");
        (0, vitest_1.expect)(elements.get("successBox").innerHTML).toContain("Restored previous state");
        (0, vitest_1.expect)(elements.get("restoreBtn").classList.contains("hidden")).toBe(true);
    });
});
(0, vitest_1.describe)("UI progress feedback", () => {
    (0, vitest_1.it)("renders progress while a run is in progress", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        let resolveFetch;
        context.fetch = vitest_1.vi.fn().mockImplementation(() => new Promise((resolve) => {
            resolveFetch = resolve;
        }));
        context.selectRole(roleButtons.dataAnalyst);
        elements.get("task").value = "create orders table";
        elements.get("repoPath").value = "C:/repo/zone-flyway-test";
        const execution = context.execute();
        const source = MockEventSource.instances[0];
        source.emit({ stage: "Building prompt..." });
        (0, vitest_1.expect)(elements.get("progressBox").classList.contains("hidden")).toBe(false);
        (0, vitest_1.expect)(elements.get("progressText").textContent).toBe("⏳ Building prompt...");
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
    (0, vitest_1.it)("reset clears progress state", () => {
        const { context, elements } = buildUiHarness();
        context.setProgress("Generating patch...");
        context.resetUI();
        (0, vitest_1.expect)(elements.get("progressText").textContent).toBe("");
        (0, vitest_1.expect)(elements.get("progressBox").classList.contains("hidden")).toBe(true);
    });
    (0, vitest_1.it)("final completion resolves progress to Ready", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi.fn().mockResolvedValue({
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
        (0, vitest_1.expect)(elements.get("progressText").textContent).toBe("⏳ Ready");
        (0, vitest_1.expect)(elements.get("progressBox").classList.contains("hidden")).toBe(false);
    });
    (0, vitest_1.it)("starting a new run resets previous progress state safely", async () => {
        const { context, elements, roleButtons } = buildUiHarness();
        context.fetch = vitest_1.vi
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
        (0, vitest_1.expect)(elements.get("progressText").textContent).toBe("⏳ Ready");
        await context.execute();
        (0, vitest_1.expect)(firstSource.closed).toBe(true);
        (0, vitest_1.expect)(elements.get("progressText").textContent).toBe("⏳ Ready");
    });
});
//# sourceMappingURL=index.test.js.map