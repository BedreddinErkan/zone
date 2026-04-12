import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoFile } from "../types/project.js";

const scanRepoMock = vi.fn();
const detectProjectStructureMock = vi.fn();
const rankRelevantFilesMock = vi.fn();
const readProjectFilesMock = vi.fn();
const planFeatureWithLlmMock = vi.fn();
const planPatchPreviewWithLlmMock = vi.fn();
const planFullPatchWithLlmMock = vi.fn();

vi.mock("../repo/scanRepo.js", () => ({
  scanRepo: scanRepoMock,
}));

vi.mock("../repo/detectProjectStructure.js", () => ({
  detectProjectStructure: detectProjectStructureMock,
}));

vi.mock("../repo/rankRelevantFiles.js", () => ({
  rankRelevantFiles: rankRelevantFilesMock,
}));

vi.mock("../repo/readProjectFiles.js", () => ({
  readProjectFiles: readProjectFilesMock,
}));

vi.mock("../llm/planFeature.js", () => ({
  planFeatureWithLlm: planFeatureWithLlmMock,
}));

vi.mock("../llm/planPatchPreview.js", () => ({
  planPatchPreviewWithLlm: planPatchPreviewWithLlmMock,
}));

vi.mock("../llm/planFullPatch.js", () => ({
  planFullPatchWithLlm: planFullPatchWithLlmMock,
}));

function buildRepoFile(
  path: string,
  category: RepoFile["category"] = "unknown"
): RepoFile {
  return {
    path,
    absolutePath: `C:/repo/${path}`,
    extension: path.split(".").pop() ?? "",
    category,
  };
}

describe("runLlmPatchFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("supplements sparse llm suggestions with ranked relevant files for developer context", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
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

    expect(result.ok).toBe(true);
    expect(planFeatureWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          normalizedTask: "fix auth bug in login flow",
        }),
        existingFilesSummary: expect.stringContaining(
          "EXISTING FILES IN REPO (use ONLY these paths, do not invent new ones):"
        ),
      })
    );
    expect(planFeatureWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        existingFilesSummary: expect.stringContaining("- src/App.tsx"),
      })
    );
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
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
      })
    );
  });

  it("excludes irrelevant environment and build files from developer context selection", async () => {
    const files = [
      buildRepoFile("src/styles/landing.css", "frontend"),
      buildRepoFile("node_modules/library/index.js", "unknown"),
      buildRepoFile("venv/lib/site-packages/pkg.py", "unknown"),
      buildRepoFile("dist/assets/app.css", "frontend"),
      buildRepoFile("build/output.css", "frontend"),
    ];

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Frontend app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 35 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Adjust landing spacing",
      steps: ["Tweak landing card gap"],
      suggestedFiles: [
        { path: "node_modules/library/index.js", reason: "bad suggestion", action: "inspect" },
        { path: "src/styles/landing.css", reason: "Actual target", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, `content:${filePath}`]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Tighten card gap",
      patches: [],
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix spacing between landing cards",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planPatchPreviewWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedFiles: [
          {
            path: "src/styles/landing.css",
            reason: "Actual target",
            action: "modify",
          },
        ],
      })
    );
  });

  it("flags and rejects generic scaffold overwrites for existing html files on small ui tasks", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<h1>Zone</h1><button>Execute</button><button>Reset</button><section id="patchSection" class="section">Patch Preview</section><div id="progressBox" class="progress-box"></div><div class="badge-row"></div><div class="context-files"></div><div class="recent-runs">Recent Runs</div>`,
        ])
      )
    );
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
      fullContent:
        `<!DOCTYPE html><html><body><h1>Welcome to My App</h1><section>Features</section><button>Get Started</button><div>Application Dashboard</div></body></html>`,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small UI polish and readability improvements for the existing page",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
    }
  });

  it("rejects generic document skeleton outputs for existing ui files on small ui tasks", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<body><h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="recent-runs">Recent Runs</div></body>`,
        ])
      )
    );
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
      fullContent:
        `<!DOCTYPE html><html><head><title>Document</title></head><body><div id="app"></div><script src="/path/to/your/script.js"></script></body></html>`,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small UI style tweak for readability",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
      expect(result.warnings.join("\n")).toContain("generic document skeleton");
    }
  });

  it("rejects broad rewrites that remove existing ui anchors on small spacing tasks", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><section id="patchSection" class="section">Patch Preview</section><aside class="recent-runs">Recent Runs</aside><div id="progressBox" class="progress-box"></div>`,
        ])
      )
    );
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
      fullContent:
        `<main class="shell"><section class="hero"><h2>Cleaner interface</h2><p>Updated spacing and layout.</p></section><section class="content-grid"><div class="panel"></div><div class="panel"></div><div class="panel"></div></section></main>`,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small spacing polish for the existing ui",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings.join("\n")).toContain("DEVELOPER_UI_OVERWRITE");
      expect(result.warnings.join("\n")).toContain("critical existing UI anchors");
    }
  });

  it("allows a real minimal ui tweak for an existing html file", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<body><h1>Zone</h1><div class="toolbar"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="badge-row"></div><div class="context-files"></div><div class="recent-runs">Recent Runs</div></body>`,
        ])
      )
    );
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
      fullContent:
        `<body><h1>Zone</h1><div class="toolbar compact"><button>Execute</button><button>Reset</button></div><div id="progressBox" class="progress-box"></div><div id="patchSection" class="section">Patch Preview</div><div class="badge-row"></div><div class="context-files readable" style="line-height:1.7"></div><div class="recent-runs">Recent Runs</div></body>`,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small UI polish and readability improvements for the existing page",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.warnings.join("\n")).not.toContain("DEVELOPER_UI_OVERWRITE");
    }
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: "C:/repo",
        taskIntent: expect.stringContaining("small ui polish"),
        relevantFiles: expect.arrayContaining([
          expect.objectContaining({ path: "src/pages/home.html" }),
        ]),
        existingTargetFiles: expect.arrayContaining(["src/pages/home.html"]),
      })
    );
  });

  it("downgrades oversized css rewrites for micro-edit tasks to preview_only", async () => {
    const files = [buildRepoFile("src/styles/landing.css", "frontend")];
    const originalCss = Array.from(
      { length: 95 },
      (_, index) => `.analysis-card-${index} { gap: ${index % 5}px; margin: 0; }`
    ).join("\n");
    const rewrittenCss = Array.from(
      { length: 95 },
      (_, index) =>
        `.analysis-card-${index} { display: grid; gap: ${index % 7}px; margin: 12px; padding: 16px; border-radius: 12px; }`
    ).join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["Marketing site"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 42 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Tighten landing card spacing",
      steps: ["Adjust spacing only"],
      suggestedFiles: [
        { path: "src/styles/landing.css", reason: "Landing styles", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalCss]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Adjust spacing between analysis cards",
      patches: [
        {
          path: "src/styles/landing.css",
          operation: "modify",
          summary: "Adjust card spacing",
          targetHint: "analysis cards",
          contentPreview: "gap tweak",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/styles/landing.css",
      fullContent: rewrittenCss,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "Fix spacing between the analysis cards on the SmileAI landing page. Do not change layout structure or card content.",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.decisionMode).toBe("preview_only");
      expect(result.intentMismatch).toEqual(
        expect.objectContaining({
          hasMismatch: true,
          severity: "high",
          reasonCodes: expect.arrayContaining([
            "LARGE_REWRITE",
            "STRUCTURAL_LAYOUT_CHANGE",
            "MASSIVE_STYLE_INJECTION",
          ]),
        })
      );
      expect(result.patchQuality).toEqual(
        expect.objectContaining({
          qualityScore: expect.any(Number),
          semanticAlignmentScore: expect.any(Number),
        })
      );
      expect(result.microEditProtection).toEqual(
        expect.objectContaining({
          isViolation: true,
          shouldForcePreview: true,
          violationReasons: expect.arrayContaining([
            "Micro-edit patch expanded into a large rewrite.",
            "Micro-edit patch introduced structural change.",
          ]),
        })
      );
      expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "preview_only",
          safetyReasons: expect.arrayContaining([
            "Intent mismatch requires manual preview.",
          ]),
        })
      );
      expect(result.patchQuality?.qualityScore).toBeLessThan(80);
      expect(result.developerRisk?.score).toBeGreaterThan(0);
      expect(result.developerRisk?.breakdown.massScope).toBeGreaterThan(0);
      expect(result.warnings).toContain(
        "Micro-edit task produced a larger-than-expected patch."
      );
      expect(result.warnings).toContain(
        "CSS patch scope is too large for a spacing-only request."
      );
    }
  });

  it("caps confidence for medium severity intent mismatch without adding a new hard block rule", async () => {
    const files = [
      buildRepoFile("src/components/Header.tsx", "frontend"),
      buildRepoFile("src/components/Footer.tsx", "frontend"),
    ];
    const originalContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <span className="eyebrow">before</span>',
      '      <span className="footer-copy">before</span>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");
    const updatedHeaderContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <span className="eyebrow">after</span>',
      '      <span className="footer-copy">before</span>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");
    const updatedFooterContent = [
      "export function Header() {",
      "  return (",
      '    <header className="header">',
      '      <span className="eyebrow">before</span>',
      '      <span className="footer-copy">after</span>',
      "    </header>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([
      { ...files[0], score: 40 },
      { ...files[1], score: 38 },
    ]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix small copy polish",
      steps: ["Update two labels"],
      suggestedFiles: [
        { path: "src/components/Header.tsx", reason: "Header copy", action: "modify" },
        { path: "src/components/Footer.tsx", reason: "Footer copy", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Adjust two labels",
      patches: [
        {
          path: "src/components/Header.tsx",
          operation: "modify",
          summary: "Update header copy",
          targetHint: "label text",
          contentPreview: "after",
        },
        {
          path: "src/components/Footer.tsx",
          operation: "modify",
          summary: "Update footer copy",
          targetHint: "label text",
          contentPreview: "after",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock
      .mockResolvedValueOnce({
        mode: "full_content",
        summary: "Generated content",
        warnings: [],
        filePath: "src/components/Header.tsx",
        fullContent: updatedHeaderContent,
      })
      .mockResolvedValueOnce({
        mode: "full_content",
        summary: "Generated content",
        warnings: [],
        filePath: "src/components/Footer.tsx",
        fullContent: updatedFooterContent,
      });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix small copy typo in the header label",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intentMismatch).toEqual(
        expect.objectContaining({
          hasMismatch: true,
          severity: "medium",
          reasonCodes: expect.arrayContaining(["MULTI_FILE_EXPANSION"]),
        })
      );
      expect(result.patchQuality).toEqual(
        expect.objectContaining({
          qualityScore: expect.any(Number),
          semanticAlignmentScore: 70,
        })
      );
      expect(result.microEditProtection).toEqual(
        expect.objectContaining({
          isViolation: true,
          shouldForcePreview: true,
          violationReasons: expect.arrayContaining([
            "Micro-edit patch changed multiple files.",
          ]),
        })
      );
      expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "preview_only",
          safetyReasons: expect.arrayContaining([
            "Intent mismatch requires manual preview.",
          ]),
        })
      );
      expect(result.developerConfidence).toBe(55);
      expect(result.warnings).toContain(
        "Micro-edit task produced a larger-than-expected patch."
      );
    }
  });

  it("keeps normal flow unchanged when there is no intent mismatch", async () => {
    const files = [buildRepoFile("src/components/Banner.tsx", "frontend")];
    const originalContent = [
      "export function Banner() {",
      "  return (",
      '    <section className="banner">',
      '      <span className="eyebrow">before</span>',
      '      <strong>Welcome</strong>',
      "    </section>",
      "  );",
      "}",
    ].join("\n");
    const updatedContent = [
      "export function Banner() {",
      "  return (",
      '    <section className="banner">',
      '      <span className="eyebrow">after</span>',
      '      <strong>Welcome</strong>',
      "    </section>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React app"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 33 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Fix one small copy string",
      steps: ["Update single string"],
      suggestedFiles: [
        { path: "src/components/Banner.tsx", reason: "Banner copy", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Adjust banner text",
      patches: [
        {
          path: "src/components/Banner.tsx",
          operation: "modify",
          summary: "Update banner copy",
          targetHint: "banner text",
          contentPreview: "after",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      summary: "Generated content",
      warnings: [],
      filePath: "src/components/Banner.tsx",
      fullContent: updatedContent,
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "fix copy typo in the banner text",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intentMismatch).toEqual({
        hasMismatch: false,
        severity: "none",
        reasonCodes: [],
        warnings: [],
      });
      expect(result.patchQuality).toEqual(
        expect.objectContaining({
          qualityScore: expect.any(Number),
          qualityWarnings: [],
        })
      );
      expect(result.microEditProtection).toEqual({
        isViolation: false,
        violationReasons: [],
        shouldForcePreview: false,
        shouldDowngradeSafety: false,
      });
      expect(result.safetyResolution).toEqual(
        expect.objectContaining({
          safetyLevel: "safe_auto_apply",
        })
      );
      expect(result.patchQuality?.qualityScore).toBeGreaterThanOrEqual(90);
      expect(result.decisionMode).toBe("safe_to_apply");
      expect(result.warnings).not.toContain(
        "Micro-edit task produced a larger-than-expected patch."
      );
    }
  });

  it("adds review risk and caps confidence for ui mapping swap tasks", async () => {
    const files = [buildRepoFile("src/components/Timeline.tsx", "frontend")];
    const originalContent = [
      "export function Timeline() {",
      "  return (",
      "    <section>",
      '      <Card title="Before" description="Old copy" />',
      '      <Card title="After" description="New copy" />',
      "    </section>",
      "  );",
      "}",
    ].join("\n");
    const updatedContent = [
      "export function Timeline() {",
      "  return (",
      "    <section>",
      '      <Card title="After" description="New copy" />',
      '      <Card title="Before" description="Old copy" />',
      "    </section>",
      "  );",
      "}",
    ].join("\n");

    scanRepoMock.mockResolvedValue(files);
    detectProjectStructureMock.mockReturnValue({ notes: ["React landing page"] });
    rankRelevantFilesMock.mockReturnValue([{ ...files[0], score: 38 }]);
    planFeatureWithLlmMock.mockResolvedValue({
      implementationSummary: "Swap before/after card mapping",
      steps: ["Reverse card order"],
      suggestedFiles: [
        { path: "src/components/Timeline.tsx", reason: "Timeline cards", action: "modify" },
      ],
      risks: [],
    });
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, originalContent]))
    );
    planPatchPreviewWithLlmMock.mockResolvedValue({
      summary: "Swap card order",
      patches: [
        {
          path: "src/components/Timeline.tsx",
          operation: "modify",
          summary: "Swap the before/after cards",
          targetHint: "card order",
          contentPreview: "Before/After order",
        },
      ],
      warnings: [],
    });
    planFullPatchWithLlmMock.mockResolvedValue({
      mode: "full_content",
      filePath: "src/components/Timeline.tsx",
      fullContent: updatedContent,
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "swap the before and after card mapping on the landing page",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.developerConfidence).toBeLessThanOrEqual(70);
      expect(result.developerRisk?.score).toBeGreaterThan(0);
      expect(result.warnings).toContain(
        "UI mapping/order changes are higher-risk and should be reviewed carefully."
      );
    }
  });

  it("uses targeted existing-file snippet context for small spacing tasks", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          filePath.endsWith("home.html")
            ? currentHtml
            : ".content { line-height: 1.5; padding: 12px; }",
        ])
      )
    );
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
      fullContent: currentHtml.replace(
        "line-height:1.5;padding:12px",
        "line-height:1.7;padding:16px"
      ),
      summary: "Generated content",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small spacing and line-height polish for the existing ui",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    expect(planFullPatchWithLlmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        relevantFiles: [
          expect.objectContaining({
            path: "src/pages/home.html",
            content: expect.stringContaining("line-height:1.5"),
          }),
          expect.objectContaining({
            path: "src/styles/theme.css",
          }),
        ],
      })
    );
    const relevantFilesArg = planFullPatchWithLlmMock.mock.calls[0][0].relevantFiles;
    expect(relevantFilesArg[0].content).toContain("// === SNIPPET:");
    expect(relevantFilesArg[0].content).toContain("padding:12px");
  });

  it("rejects invalid full-file scaffold output that is not patch-style", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(
        paths.map((filePath) => [
          filePath,
          `<body><h1>Zone</h1><button>Execute</button><button>Reset</button></body>`,
        ])
      )
    );
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
      patchText:
        `<!DOCTYPE html><html><head><title>Document</title></head><body><div id="app"></div></body></html>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "small spacing tweak for the existing ui",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings.join("\n")).toContain("DEVELOPER_PATCH_FORMAT");
    }
  });

  it("applies raw find/replace patch mode for large files", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
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
      patchText:
        `--- FIND ---\n<button class="exec-btn">Execute</button>\n--- REPLACE ---\n<button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.applyPatches[0].fullContent).toContain(
        'style="background:#1a8cdb"'
      );
      expect(result.warnings.join("\n")).not.toContain("PATCH_FIND_NOT_FOUND");
    }
  });

  it("applies large-file patch mode when whitespace differs", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
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
      patchText:
        `--- FIND ---\n<button class="exec-btn">Execute</button>\n--- REPLACE ---\n<button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.applyPatches[0].fullContent).toContain(
        'style="background:#1a8cdb"'
      );
    }
  });

  it("applies large-file patch mode when tabs differ from spaces", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
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
      patchText:
        `--- FIND ---\n  <button class="exec-btn">Execute</button>\n--- REPLACE ---\n  <button class="exec-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toHaveLength(1);
      expect(result.applyPatches[0].fullContent).toContain(
        'style="background:#1a8cdb"'
      );
    }
  });

  it("fails gracefully when fuzzy large-file patch match cannot be found", async () => {
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
    readProjectFilesMock.mockImplementation(async (paths: string[]) =>
      Object.fromEntries(paths.map((filePath) => [filePath, currentHtml]))
    );
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
      patchText:
        `--- FIND ---\n<button class="missing-btn">Execute</button>\n--- REPLACE ---\n<button class="missing-btn" style="background:#1a8cdb">Execute</button>`,
      summary: "Large-file targeted patch generated.",
      warnings: [],
    });

    const { runLlmPatchFlow } = await import("./runLlmPatchFlow.js");
    const result = await runLlmPatchFlow({
      task: "change Execute button color",
      repoPath: "C:/repo",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings.join("\n")).toContain("PATCH_FIND_NOT_FOUND");
      expect(result.warnings.join("\n")).toContain('"reason":"low_confidence"');
      expect(result.warnings.join("\n")).toContain('"score":');
    }
  });

  it("blocks protected src/ui files from developer apply patches", async () => {
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

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.applyPatches).toEqual([]);
      expect(result.warnings).toContain(
        "[PROTECTED_FILE] src/ui/ files cannot be modified by Zone developer mode"
      );
    }
    expect(planFullPatchWithLlmMock).not.toHaveBeenCalled();
  });
});
