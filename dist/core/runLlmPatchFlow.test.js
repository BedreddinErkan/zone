"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const scanRepoMock = vitest_1.vi.fn();
const detectProjectStructureMock = vitest_1.vi.fn();
const rankRelevantFilesMock = vitest_1.vi.fn();
const readProjectFilesMock = vitest_1.vi.fn();
const planFeatureWithLlmMock = vitest_1.vi.fn();
const planPatchPreviewWithLlmMock = vitest_1.vi.fn();
const planFullPatchWithLlmMock = vitest_1.vi.fn();
vitest_1.vi.mock("../repo/scanRepo.js", () => ({
    scanRepo: scanRepoMock,
}));
vitest_1.vi.mock("../repo/detectProjectStructure.js", () => ({
    detectProjectStructure: detectProjectStructureMock,
}));
vitest_1.vi.mock("../repo/rankRelevantFiles.js", () => ({
    rankRelevantFiles: rankRelevantFilesMock,
}));
vitest_1.vi.mock("../repo/readProjectFiles.js", () => ({
    readProjectFiles: readProjectFilesMock,
}));
vitest_1.vi.mock("../llm/planFeature.js", () => ({
    planFeatureWithLlm: planFeatureWithLlmMock,
}));
vitest_1.vi.mock("../llm/planPatchPreview.js", () => ({
    planPatchPreviewWithLlm: planPatchPreviewWithLlmMock,
}));
vitest_1.vi.mock("../llm/planFullPatch.js", () => ({
    planFullPatchWithLlm: planFullPatchWithLlmMock,
}));
function buildRepoFile(path, category = "unknown") {
    return {
        path,
        absolutePath: `C:/repo/${path}`,
        extension: path.split(".").pop() ?? "",
        category,
    };
}
(0, vitest_1.describe)("runLlmPatchFlow", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)("supplements sparse llm suggestions with ranked relevant files for developer context", async () => {
        const files = [
            buildRepoFile("src/App.tsx", "frontend"),
            buildRepoFile("server/routes/auth.ts", "backend"),
            buildRepoFile("server/middleware/session.ts", "backend"),
        ];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["React + Express"] });
        rankRelevantFilesMock.mockReturnValue([
            { ...files[1], score: 30 },
            { ...files[2], score: 28 },
            { ...files[0], score: 12 },
        ]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Fix auth flow",
            steps: ["Update auth route"],
            suggestedFiles: [
                { path: "src/App.tsx", reason: "Visible entry point", action: "inspect" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Patch summary",
            patches: [],
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "fix auth bug in login flow",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        (0, vitest_1.expect)(planFeatureWithLlmMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            intent: vitest_1.expect.objectContaining({
                normalizedTask: "fix auth bug in login flow",
            }),
            existingFilesSummary: vitest_1.expect.stringContaining("EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):"),
        }));
        (0, vitest_1.expect)(planFeatureWithLlmMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            existingFilesSummary: vitest_1.expect.stringContaining("- src/App.tsx"),
        }));
        (0, vitest_1.expect)(planPatchPreviewWithLlmMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            suggestedFiles: [
                { path: "src/App.tsx", reason: "Visible entry point", action: "inspect" },
                {
                    path: "server/routes/auth.ts",
                    reason: "High repo relevance for the requested developer task",
                    action: "inspect",
                },
                {
                    path: "server/middleware/session.ts",
                    reason: "High repo relevance for the requested developer task",
                    action: "inspect",
                },
            ],
        }));
    });
    (0, vitest_1.it)("flags and rejects generic scaffold overwrites for existing html files on small ui tasks", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Tighten spacing"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            `<h1>Zone</h1><button>Execute</button><button>Reset</button><section id="patchSection" class="section">Patch Preview</section><div id="progressBox" class="progress-box"></div><div class="badge-row"></div><div class="context-files"></div><div class="recent-runs">Recent Runs</div>`,
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish the existing UI",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Improve readability",
                    targetHint: "main layout",
                    contentPreview: "Update spacing",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "full_content",
            filePath: "src/pages/home.html",
            fullContent: `<!DOCTYPE html><html><body><h1>Welcome to My App</h1><section>Features</section><button>Get Started</button><div>Application Dashboard</div></body></html>`,
            summary: "Generated content",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "small UI polish and readability improvements for the existing page",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toEqual([]);
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
        }
    });
    (0, vitest_1.it)("rejects generic document skeleton outputs for existing ui files on small ui tasks", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust line height"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            `<body><h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="recent-runs">Recent Runs</div></body>`,
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish line height",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Adjust text spacing",
                    targetHint: "styles",
                    contentPreview: "line-height tweak",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "full_content",
            filePath: "src/pages/home.html",
            fullContent: `<!DOCTYPE html><html><head><title>Document</title></head><body><div id="app"></div><script src="/path/to/your/script.js"></script></body></html>`,
            summary: "Generated content",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "small UI style tweak for readability",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toEqual([]);
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain("generic document skeleton");
        }
    });
    (0, vitest_1.it)("rejects broad rewrites that remove existing ui anchors on small spacing tasks", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust spacing"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            `<h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><section id="patchSection" class="section">Patch Preview</section><aside class="recent-runs">Recent Runs</aside><div id="progressBox" class="progress-box"></div>`,
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish spacing",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Adjust spacing across the page",
                    targetHint: "layout",
                    contentPreview: "spacing polish",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "full_content",
            filePath: "src/pages/home.html",
            fullContent: `<main class="shell"><section class="hero"><h2>Cleaner interface</h2><p>Updated spacing and layout.</p></section><section class="content-grid"><div class="panel"></div><div class="panel"></div><div class="panel"></div></section></main>`,
            summary: "Generated content",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "small spacing polish for the existing ui",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toEqual([]);
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain("critical existing UI anchors");
        }
    });
    (0, vitest_1.it)("allows a real minimal ui tweak for an existing html file", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust font size"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            `<body><h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="badge-row"></div><div class="context-files"></div><div class="recent-runs">Recent Runs</div></body>`,
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish the existing UI",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Increase body line height slightly",
                    targetHint: "style block",
                    contentPreview: "line-height: 1.7",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "full_content",
            filePath: "src/pages/home.html",
            fullContent: `<body><h1>Zone</h1><div class="toolbar compact"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="badge-row"></div><div class="context-files readable" style="line-height:1.7"></div><div class="recent-runs">Recent Runs</div></body>`,
            summary: "Generated content",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "small UI polish and readability improvements for the existing page",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toHaveLength(1);
            (0, vitest_1.expect)(result.warnings.join("\n")).not.toContain("DEVELOPER_UI_OVERWRITE");
        }
        (0, vitest_1.expect)(planFullPatchWithLlmMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            repoPath: "C:/repo",
            taskIntent: vitest_1.expect.stringContaining("small ui polish"),
            relevantFiles: vitest_1.expect.arrayContaining([
                vitest_1.expect.objectContaining({ path: "src/pages/home.html" }),
            ]),
            existingTargetFiles: vitest_1.expect.arrayContaining(["src/pages/home.html"]),
        }));
    });
    (0, vitest_1.it)("uses targeted existing-file snippet context for small spacing tasks", async () => {
        const files = [
            buildRepoFile("src/pages/home.html", "frontend"),
            buildRepoFile("src/styles/theme.css", "frontend"),
        ];
        const currentHtml = [
            "<body>",
            '<div class="hero">Welcome</div>',
            '<div id="progressBox" class="progress-box"></div>',
            '<div id="patchSection" class="section">Patch Preview</div>',
            '<div class="content readable" style="line-height:1.5;padding:12px">Body</div>',
            '<div class="recent-runs">Recent Runs</div>',
            "</body>",
        ].join("\n");
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([
            { ...files[0], score: 40 },
            { ...files[1], score: 18 },
        ]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust spacing"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
                { path: "src/styles/theme.css", reason: "Related style file", action: "inspect" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            filePath.endsWith("home.html")
                ? currentHtml
                : ".content { line-height: 1.5; padding: 12px; }",
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish spacing",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Adjust spacing in the content block",
                    targetHint: "content block",
                    contentPreview: "padding and line-height tweak",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "full_content",
            filePath: "src/pages/home.html",
            fullContent: currentHtml.replace("line-height:1.5;padding:12px", "line-height:1.7;padding:16px"),
            summary: "Generated content",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "small spacing and line-height polish for the existing ui",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        (0, vitest_1.expect)(planFullPatchWithLlmMock).toHaveBeenCalledWith(vitest_1.expect.objectContaining({
            relevantFiles: [
                vitest_1.expect.objectContaining({
                    path: "src/pages/home.html",
                    content: vitest_1.expect.stringContaining("line-height:1.5"),
                }),
                vitest_1.expect.objectContaining({
                    path: "src/styles/theme.css",
                }),
            ],
        }));
        const relevantFilesArg = planFullPatchWithLlmMock.mock.calls[0][0].relevantFiles;
        (0, vitest_1.expect)(relevantFilesArg[0].content).toContain("// === SNIPPET:");
        (0, vitest_1.expect)(relevantFilesArg[0].content).toContain("padding:12px");
    });
    (0, vitest_1.it)("rejects invalid full-file scaffold output that is not patch-style", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust spacing"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [
            filePath,
            `<body><h1>Zone</h1><button>Execute</button><button>Reset</button></body>`,
        ])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish spacing",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Adjust spacing",
                    targetHint: "body styles",
                    contentPreview: "spacing polish",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "patch",
            filePath: "src/pages/home.html",
            patchText: `<!DOCTYPE html><html><head><title>Document</title></head><body><div id="app"></div></body></html>`,
            summary: "Large-file targeted patch generated.",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "small spacing tweak for the existing ui",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toEqual([]);
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain("DEVELOPER_PATCH_FORMAT");
        }
    });
    (0, vitest_1.it)("applies raw find/replace patch mode for large files", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        const currentHtml = `${"<div class=\"line\">filler</div>\n".repeat(400)}<button class="exec-btn">Execute</button>\n${"<div class=\"line\">after</div>\n".repeat(400)}`;
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust button color"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [filePath, currentHtml])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish button color",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Update execute button styling",
                    targetHint: "button block",
                    contentPreview: "button color tweak",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "patch",
            filePath: "src/pages/home.html",
            patchText: `--- FIND ---\n<button class="exec-btn">Execute</button>\n--- REPLACE ---\n<button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
            summary: "Large-file targeted patch generated.",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "change Execute button color",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toHaveLength(1);
            (0, vitest_1.expect)(result.applyPatches[0].fullContent).toContain('style="background:#1a8cdb"');
            (0, vitest_1.expect)(result.warnings.join("\n")).not.toContain("PATCH_FIND_NOT_FOUND");
        }
    });
    (0, vitest_1.it)("applies large-file patch mode when whitespace differs", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        const currentHtml = [
            "<body>",
            '  <button class="exec-btn">Execute</button>',
            "</body>",
        ].join("\n");
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust button color"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [filePath, currentHtml])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish button color",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Update execute button styling",
                    targetHint: "button block",
                    contentPreview: "button color tweak",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "patch",
            filePath: "src/pages/home.html",
            patchText: `--- FIND ---\n<button class="exec-btn">Execute</button>\n--- REPLACE ---\n<button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
            summary: "Large-file targeted patch generated.",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "change Execute button color",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toHaveLength(1);
            (0, vitest_1.expect)(result.applyPatches[0].fullContent).toContain('style="background:#1a8cdb"');
        }
    });
    (0, vitest_1.it)("applies large-file patch mode when tabs differ from spaces", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        const currentHtml = [
            "<body>",
            '\t<button class="exec-btn">Execute</button>',
            "</body>",
        ].join("\n");
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust button color"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [filePath, currentHtml])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish button color",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Update execute button styling",
                    targetHint: "button block",
                    contentPreview: "button color tweak",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "patch",
            filePath: "src/pages/home.html",
            patchText: `--- FIND ---\n  <button class="exec-btn">Execute</button>\n--- REPLACE ---\n  <button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
            summary: "Large-file targeted patch generated.",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "change Execute button color",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toHaveLength(1);
            (0, vitest_1.expect)(result.applyPatches[0].fullContent).toContain('style="background:#1a8cdb"');
        }
    });
    (0, vitest_1.it)("fails gracefully when fuzzy large-file patch match cannot be found", async () => {
        const files = [buildRepoFile("src/pages/home.html", "frontend")];
        const currentHtml = [
            "<body>",
            '  <button class="exec-btn">Execute</button>',
            "</body>",
        ].join("\n");
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust button color"],
            suggestedFiles: [
                { path: "src/pages/home.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockImplementation(async (paths) => Object.fromEntries(paths.map((filePath) => [filePath, currentHtml])));
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish button color",
            patches: [
                {
                    path: "src/pages/home.html",
                    operation: "modify",
                    summary: "Update execute button styling",
                    targetHint: "button block",
                    contentPreview: "button color tweak",
                },
            ],
            warnings: [],
        });
        planFullPatchWithLlmMock.mockResolvedValue({
            mode: "patch",
            filePath: "src/pages/home.html",
            patchText: `--- FIND ---\n<button class="missing-btn">Execute</button>\n--- REPLACE ---\n<button class="missing-btn" style="background:#1a8cdb">Execute</button>`,
            summary: "Large-file targeted patch generated.",
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "change Execute button color",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toEqual([]);
            (0, vitest_1.expect)(result.warnings.join("\n")).toContain("PATCH_FIND_NOT_FOUND");
        }
    });
    (0, vitest_1.it)("blocks protected src/ui files from developer apply patches", async () => {
        const files = [buildRepoFile("src/ui/index.html", "frontend")];
        scanRepoMock.mockResolvedValue(files);
        detectProjectStructureMock.mockReturnValue({ notes: ["Static UI"] });
        rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 40 }]);
        planFeatureWithLlmMock.mockResolvedValue({
            implementationSummary: "Polish UI",
            steps: ["Adjust spacing"],
            suggestedFiles: [
                { path: "src/ui/index.html", reason: "Main UI file", action: "modify" },
            ],
            risks: [],
        });
        readProjectFilesMock.mockResolvedValue({});
        planPatchPreviewWithLlmMock.mockResolvedValue({
            summary: "Polish spacing",
            patches: [
                {
                    path: "src/ui/index.html",
                    operation: "modify",
                    summary: "Adjust spacing",
                    targetHint: "body styles",
                    contentPreview: "spacing polish",
                },
            ],
            warnings: [],
        });
        const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
        const result = await runLlmPatchFlow({
            task: "small spacing tweak for the existing ui",
            repoPath: "C:/repo",
        });
        (0, vitest_1.expect)(result.ok).toBe(true);
        if (result.ok) {
            (0, vitest_1.expect)(result.applyPatches).toEqual([]);
            (0, vitest_1.expect)(result.warnings).toContain("[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode");
        }
        (0, vitest_1.expect)(planFullPatchWithLlmMock).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=runLlmPatchFlow.test.js.map