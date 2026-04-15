import { describe, expect, it } from "vitest";
import { buildDeveloperPrompt } from "./developerPrompt.js";

describe("buildDeveloperPrompt", () => {
  it("enforces existing-repo and minimal-diff behavior", () => {
    const prompt = buildDeveloperPrompt({
      task: "small UI polish and readability improvements for src/ui/index.html",
      repoPath: "C:/repo",
      taskIntent: "ui polish",
      existingTargetFiles: ["src/ui/index.html"],
      targetFilePath: "src/ui/index.html",
      targetFileContent: '<div id="progressBox" class="progress-box"></div>',
      repoSummary: "Zone dark UI app.",
      relatedContext: "Keep patch preview readable.",
      relevantFiles: [
        {
          path: "src/ui/index.html",
          content: '<div id="patchSection" class="section"></div>',
        },
      ],
    });

    expect(prompt).toContain("real existing repository");
    expect(prompt).toContain("Keep the diff minimal and localized");
    expect(prompt).toContain("Modify existing files in place whenever possible");
    expect(prompt).toContain("return the file unchanged and add a warning");
  });

  it("includes anti-scaffold instructions for ui tasks", () => {
    const prompt = buildDeveloperPrompt({
      task: "polish the existing UI page",
      repoPath: "C:/repo",
      taskIntent: "ui polish",
      existingTargetFiles: ["src/ui/index.html"],
      targetFilePath: "src/ui/index.html",
      targetFileContent: "<body><div id=\"app\"></div></body>",
      relevantFiles: [],
    });

    expect(prompt).toContain("Do NOT generate a full HTML page");
    expect(prompt).toContain("Welcome to My App");
    expect(prompt).toContain("Get Started");
    expect(prompt).toContain("Application Dashboard");
    expect(prompt).toContain("Do NOT replace the page with generic content");
  });

  it("includes relevant file context in the prompt", () => {
    const prompt = buildDeveloperPrompt({
      task: "update auth route validation",
      repoPath: "C:/repo",
      taskIntent: "api backend",
      targetFilePath: "server/routes/auth.ts",
      targetFileContent: "router.post('/login', loginHandler);",
      relevantFiles: [
        {
          path: "server/routes/auth.ts",
          content: "router.post('/login', loginHandler);",
        },
        {
          path: "server/middleware/session.ts",
          content: "export function requireSession() {}",
        },
      ],
    });

    expect(prompt).toContain("RELEVANT REPOSITORY FILES");
    expect(prompt).toContain("FILE: server/routes/auth.ts");
    expect(prompt).toContain("FILE: server/middleware/session.ts");
  });

  it("includes micro-edit instructions for small ui tasks", () => {
    const prompt = buildDeveloperPrompt({
      task: "small line-height and spacing polish for the existing UI",
      repoPath: "C:/repo",
      taskIntent: "ui polish",
      targetFilePath: "src/ui/index.html",
      targetFileContent: '<div class="content" style="line-height:1.5"></div>',
      relevantFiles: [
        {
          path: "src/ui/index.html",
          content: '<div class="content" style="line-height:1.5"></div>',
        },
      ],
    });

   expect(prompt).toContain("MICRO-EDIT MODE");
    expect(prompt).toContain("Change ONLY the single property or value explicitly requested");
    expect(prompt).toContain("Produce the smallest possible diff");
    expect(prompt).toContain("Do NOT add new elements"); });

  it("enforces patch-style output instead of full files", () => {
    const prompt = buildDeveloperPrompt({
      task: "small spacing polish for existing UI",
      repoPath: "C:/repo",
      taskIntent: "ui polish",
      targetFilePath: "src/ui/index.html",
      targetFileContent: "<body></body>",
      relevantFiles: [],
    });

    expect(prompt).toContain("DO NOT output full file content");
    expect(prompt).toContain("ONLY output patch-style edits");
    expect(prompt).toContain('"patchText"');
    expect(prompt).toContain("FIND/REPLACE");
  });
});
