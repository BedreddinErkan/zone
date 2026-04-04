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
    ensureElement("execBtn");
    ensureElement("spinner");
    ensureElement("execText");
    ensureElement("applyBtn");
    ensureElement("applySpinner");
    ensureElement("applyText");
    ensureElement("progressBox", "progress-box hidden");
    ensureElement("progressText");
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
        Math,
        Date,
        encodeURIComponent,
    };
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